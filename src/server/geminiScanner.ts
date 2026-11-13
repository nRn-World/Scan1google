import fs from 'node:fs/promises';
import { GoogleGenAI, ThinkingLevel, Type, type Part } from '@google/genai';
import {
  mergeInventoryItems,
  type InventoryItem,
  type RawDetectedPackage,
} from '../utils/inventory';

const MODEL_NAME = 'gemini-4-hydrogen';
const INLINE_SIZE_LIMIT_BYTES = 12 * 1024 * 1024; // 12 MB

const SYSTEM_INSTRUCTION = `Du är en extremt noggrann inventeringsassistent för lager och logistik.
Din uppgift är att läsa av varje fysiskt paket, fraktsedel, streckkod, QR-kod, delivery-nummer och removal-nummer som syns i videon eller bilderna.

KRITISKA REGLER FÖR NOGGRANNHET:
1. Gissa ALDRIG siffror eller bokstäver. Läs av varje tecken exakt som det står på etiketten (skilj noga på 0 och O, 1 och I, 5 och S, 8 och B).
2. Identifiera alltid:
   - customer: Kundens namn (t.ex. "Microsoft", "Google", "Amazon", "DHL", "Apple"). Leta efter företagsnamn/logotyp nära numret. Om inget kundnamn syns, skriv "Okänd kund".
   - type: Klassificera strikt som "Delivery" eller "Removal" baserat på text på etiketten (t.ex. "Delivery", "Del", "Inleverans", prefix "DEL"/"Del" => "Delivery"; "Removal", "Rem", "Retur", "Utlastning", prefix "REM"/"Rem" => "Removal"). Om typ inte går att avgöra, använd "Okänd".
   - referenceNumber: Exakt delivery- eller removal-nummer (t.ex. "Del001234567" eller "Rem004891203"). Bevara exakta tecken utan mellanslag.
   - barcode: Eventuell numerisk/alfanumerisk streckkod under en 1D/2D-streckkod om en sådan också syns.
   - quantity: Antal separata FYSISKA paket i denna observation.
     * VIKTIGT OM VIDEO: Om kameran råkar stanna kvar på eller panorera lite fram och tillbaka över EXAKT SAMMA fysiska paket/etikett, räkna det bara 1 gång!
     * Om det däremot finns 2 separata fysiska paket (bredvid varandra, staplade, eller filmade i följd efter varandra) med SAMMA nummer (t.ex. två olika lådor märkta Microsoft / Del001234567), ska båda räknas (antingen som 2 poster eller quantity: 2).
   - timestamp: Tidpunkt i videon (t.ex. "00:04") där paketet syns tydligast.
   - confidence: "high" om varje tecken är helt skarpt och tydligt; "medium" om svagt vinklat men läsbart; "low" om suddigt, repat eller delvis skymt.
   - notes: Kort kommentar på svenska endast om något bör kontrolleras manuellt (t.ex. suddig sista siffra) eller om flera likadana kolli sågs bredvid varandra.

Varje avläsning ska ge användaren en felsäker lista som kan exporteras direkt till Excel utan manuella misstag.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    packages: {
      type: Type.ARRAY,
      description: 'Lista över alla unika fysiska paket eller etiketter som observerats.',
      items: {
        type: Type.OBJECT,
        properties: {
          customer: {
            type: Type.STRING,
            description: 'Kundnamn, t.ex. Microsoft',
          },
          type: {
            type: Type.STRING,
            description: 'Delivery, Removal eller Okänd',
          },
          referenceNumber: {
            type: Type.STRING,
            description: 'Exakt delivery- eller removal-nummer, t.ex. Del001234567',
          },
          barcode: {
            type: Type.STRING,
            description: 'Eventuell streckkod som lästs av under eller vid streckkoden',
          },
          quantity: {
            type: Type.INTEGER,
            description: 'Antal separata fysiska paket för denna observation (minst 1)',
          },
          confidence: {
            type: Type.STRING,
            description: 'high, medium eller low',
          },
          timestamp: {
            type: Type.STRING,
            description: 'Tidpunkt i videon t.ex. 00:05',
          },
          notes: {
            type: Type.STRING,
            description: 'Eventuell notering på svenska vid otydlighet eller specialfall',
          },
        },
        required: ['customer', 'type', 'referenceNumber', 'quantity', 'confidence'],
      },
    },
    summaryNote: {
      type: Type.STRING,
      description: 'Kort sammanfattning på svenska av videokvaliteten och eventuella etiketter som bör dubbelkollas.',
    },
  },
  required: ['packages', 'summaryNote'],
};

export interface UploadedMediaFile {
  path: string;
  mimetype: string;
  size: number;
  originalname: string;
}

export interface ScanMediaResult {
  items: InventoryItem[];
  rawCount: number;
  summaryNote: string;
}

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY saknas på servern. Kontrollera Secrets-inställningarna.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function waitForFileActive(ai: GoogleGenAI, name: string): Promise<{ uri: string; mimeType: string }> {
  const maxAttempts = 45;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const fileInfo = await ai.files.get({ name });
    if (fileInfo.state === 'ACTIVE' && fileInfo.uri) {
      return {
        uri: fileInfo.uri,
        mimeType: fileInfo.mimeType || 'video/mp4',
      };
    }
    if (fileInfo.state === 'FAILED') {
      throw new Error('Videofilen kunde inte bearbetas av AI-tjänsten. Försök med ett kortare klipp eller MP4/WebM.');
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('Tidsgränsen överskreds när videon skulle bearbetas. Försök med ett kortare klipp.');
}

export async function analyzeUploadedMedia(
  files: UploadedMediaFile[],
  extraHint?: string
): Promise<ScanMediaResult> {
  if (!files || files.length === 0) {
    throw new Error('Ingen video- eller bildfil mottagen.');
  }

  const ai = getGenAIClient();
  const uploadedRemoteFileNames: string[] = [];
  const parts: Part[] = [];

  try {
    for (const file of files) {
      const normalizedMime = file.mimetype || 'video/webm';
      const isVideo = normalizedMime.startsWith('video/');

      if (isVideo && file.size > INLINE_SIZE_LIMIT_BYTES) {
        const uploaded = await ai.files.upload({
          file: file.path,
          config: {
            mimeType: normalizedMime,
            displayName: file.originalname || 'inventory-video',
          },
        });
        if (!uploaded.name) {
          throw new Error('Uppladdningen av videon misslyckades.');
        }
        uploadedRemoteFileNames.push(uploaded.name);
        const active = await waitForFileActive(ai, uploaded.name);
        parts.push({
          fileData: {
            fileUri: active.uri,
            mimeType: active.mimeType,
          },
        });
      } else {
        const buffer = await fs.readFile(file.path);
        parts.push({
          inlineData: {
            mimeType: normalizedMime,
            data: buffer.toString('base64'),
          },
        });
      }
    }

    const userPrompt = [
      'Analysera allt innehåll i uppladdad video/bilder noggrant.',
      'Extrahera alla synliga paket med kundnamn, typ (Delivery eller Removal), exakt delivery-/removalnummer, eventuell streckkod och antal fysiska paket.',
      'Om två fysiska paket har exakt samma nummer (t.ex. Del001234567), se till att båda räknas med så totala antalet blir 2.',
      extraHint ? `Extra kontext från användaren: ${extraHint}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    parts.push({ text: userPrompt });

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: { parts },
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.HIGH,
        },
      },
    });

    const rawText = (response.text ?? '').trim();
    if (!rawText) {
      throw new Error('AI-modellen returnerade ett tomt svar. Försök filma med tydligare ljus.');
    }

    const parsed = JSON.parse(rawText) as {
      packages?: RawDetectedPackage[];
      summaryNote?: string;
    };

    const rawPackages = Array.isArray(parsed.packages) ? parsed.packages : [];
    const items = mergeInventoryItems([], rawPackages);

    return {
      items,
      rawCount: rawPackages.length,
      summaryNote: parsed.summaryNote || '',
    };
  } finally {
    // Cleanup remote Gemini Files API uploads and local temp files
    await Promise.allSettled([
      ...uploadedRemoteFileNames.map((name) => ai.files.delete({ name })),
      ...files.map((file) => fs.unlink(file.path)),
    ]);
  }
}
