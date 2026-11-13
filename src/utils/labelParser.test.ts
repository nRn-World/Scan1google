import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeInventoryItems } from './inventory';
import {
  aggregateVideoFrameDetections,
  extractCustomerFromText,
  extractReferenceCandidates,
  hasValidGs1Mod10Checksum,
  isBarcodeStripeOrNoiseText,
  parseLabelFrame,
} from './labelParser';
import { LiveCameraScannerSession } from './localScanner';

test('pairs label OCR Del-number with scanned 1D barcode into a single package', () => {
  const detected = parseLabelFrame({
    frameIndex: 0,
    timestampSec: 3.2,
    sourceKind: 'video-frame',
    barcodes: [
      {
        text: '7310012345678',
        format: 'Code128',
        position: { x: 120, y: 360, width: 520, height: 110 },
      },
    ],
    ocrText: `
      DHL EXPRESS
      Kund: Microsoft
      DELIVERY
      Del001234567
      7310012345678
    `,
    ocrConfidence: 91,
  });

  assert.equal(detected.length, 1);
  assert.equal(detected[0].customer, 'Microsoft');
  assert.equal(detected[0].type, 'Delivery');
  assert.equal(detected[0].referenceNumber, 'Del001234567');
  assert.equal(detected[0].barcode, '7310012345678');
  assert.equal(detected[0].quantity, 1);
  assert.equal(detected[0].confidence, 'high');
  assert.equal(detected[0].timestamp, '00:03');
});

test('recovers common OCR character confusions in Del/Rem numbers and brand names', () => {
  const customer = extractCustomerFromText('M1crosoft Cloud\nRemoval\nRem004B912O3');
  assert.equal(customer, 'Microsoft');

  const refs = extractReferenceCandidates('Removal\nRem004B912O3', undefined, 82);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].referenceNumber, 'Rem004891203');
  assert.equal(refs[0].impliedType, 'Removal');
  assert.equal(refs[0].confidence, 'medium');
  assert.match(refs[0].note ?? '', /Kontrollera/);
});

test('rejects barcode stripe noise, dates, postal codes, phone numbers, and Del 1 av 3 fractions', () => {
  assert.equal(isBarcodeStripeOrNoiseText('111I1l|11111'), true);
  assert.equal(isBarcodeStripeOrNoiseText('111111111111'), true);
  assert.equal(isBarcodeStripeOrNoiseText('Del001234567'), false);

  const noisyFrame = parseLabelFrame({
    frameIndex: 0,
    sourceKind: 'video-frame',
    barcodes: [],
    ocrText: `
      111I1l|11111
      EXPRESS PARCEL
      2026-11-13
      164 40 Kista
      070-123 45 67
      Del 1 av 3
      Vikt 12 kg
    `,
    ocrConfidence: 62,
  });

  assert.equal(noisyFrame.length, 0);

  // Also ensure random top header noise does NOT become customer name
  const customerFromNoise = extractCustomerFromText('111I1l|11\nEXPRESS PARCEL\n164 40 Kista');
  assert.equal(customerFromNoise, 'Okänd kund');
});

test('extracts customer from multi-line MOTTAGARE / SHIP TO shipping label blocks', () => {
  const customer = extractCustomerFromText(
    'AVSÄNDARE: Lagercentralen\nMOTTAGARE:\nNordic Datacenter AB\nStorgatan 10\n164 40 Kista'
  );
  assert.equal(customer, 'Nordic Datacenter AB');
});

test('validates GS1 Modulo-10 check digits accurately', () => {
  // 7350089124508: check digit calculation -> valid EAN-13
  assert.equal(hasValidGs1Mod10Checksum('73513537'), true); // valid EAN-8
  assert.equal(hasValidGs1Mod10Checksum('4006381333931'), true); // valid EAN-13
  assert.equal(hasValidGs1Mod10Checksum('4006381333932'), false); // wrong check digit
  assert.equal(hasValidGs1Mod10Checksum('1111111111111'), false); // repeated 1s stripe noise
});

test('counts 2 spatially separated identical barcodes in one frame as quantity 2', () => {
  const detected = parseLabelFrame({
    frameIndex: 0,
    sourceKind: 'image',
    barcodes: [
      {
        text: 'Del001234567',
        format: 'Code128',
        position: { x: 80, y: 80, width: 220, height: 60 },
      },
      {
        text: 'Del001234567',
        format: 'Code128',
        position: { x: 80, y: 420, width: 220, height: 60 },
      },
    ],
    ocrText: 'Google\nDelivery\nDel001234567',
    ocrConfidence: 88,
  });

  assert.equal(detected.length, 1);
  assert.equal(detected[0].customer, 'Google');
  assert.equal(detected[0].referenceNumber, 'Del001234567');
  assert.equal(detected[0].quantity, 2);
});

test('LiveCameraScannerSession locks in all 3 distinct labels sequentially and upgrades barcode-first hits with OCR', () => {
  const session = new LiveCameraScannerSession();

  // Label 1: Tick 1 catches barcode first (35ms), Tick 2 upgrades same label with OCR customer + Del number!
  const hit1a = session.ingestDetectedPackages(
    [
      {
        customer: 'Okänd kund',
        type: 'Okänd',
        referenceNumber: '7310012345678',
        barcode: '7310012345678',
        quantity: 1,
        confidence: 'medium',
      },
    ],
    0.8
  );
  assert.equal(hit1a.newlyLocked.length, 1);

  const hit1b = session.ingestDetectedPackages(
    [
      {
        customer: 'Microsoft',
        type: 'Delivery',
        referenceNumber: 'Del001234567',
        barcode: '7310012345678',
        quantity: 1,
        confidence: 'high',
      },
    ],
    1.2
  );
  assert.equal(hit1b.newlyLocked.length, 0); // Upgraded in place, not duplicated!
  assert.equal(session.getEntries().length, 1);
  assert.equal(session.getEntries()[0].pkg.referenceNumber, 'Del001234567');
  assert.equal(session.getEntries()[0].pkg.customer, 'Microsoft');

  // Label 2: User moves camera to second label (Removal)
  const hit2 = session.ingestDetectedPackages(
    [
      {
        customer: 'Volvo',
        type: 'Removal',
        referenceNumber: 'Rem004891203',
        barcode: '7350048912034',
        quantity: 1,
        confidence: 'high',
      },
    ],
    3.4
  );
  assert.equal(hit2.newlyLocked.length, 1);
  assert.equal(session.getEntries().length, 2);

  // Label 3: User moves camera to third label (PostNord / carrier tracking JJD...)
  const hit3 = session.ingestDetectedPackages(
    [
      {
        customer: 'ABB',
        type: 'Delivery',
        referenceNumber: 'JJD0002690100998877',
        barcode: 'JJD0002690100998877',
        quantity: 1,
        confidence: 'high',
      },
    ],
    5.8
  );
  assert.equal(hit3.newlyLocked.length, 1);
  assert.equal(session.getEntries().length, 3);

  const finalResult = session.buildFinalScanResult();
  assert.equal(finalResult.items.length, 3);
  assert.deepEqual(
    finalResult.items.map((i) => i.referenceNumber).sort(),
    ['Del001234567', 'JJD0002690100998877', 'Rem004891203']
  );
});

test('temporal video aggregation deduplicates camera dwell on 1 box while counting 2 separate identical boxes', () => {
  const slices = [
    {
      frameIndex: 0,
      timestampSec: 1.0,
      packages: [
        {
          customer: 'Okänd kund',
          type: 'Okänd',
          referenceNumber: '7310012345678',
          barcode: '7310012345678',
          quantity: 1,
          confidence: 'medium',
        },
      ],
    },
    {
      frameIndex: 1,
      timestampSec: 1.5,
      packages: [
        {
          customer: 'Microsoft',
          type: 'Delivery',
          referenceNumber: 'Del001234567',
          barcode: '7310012345678',
          quantity: 1,
          confidence: 'high',
        },
      ],
    },
    {
      frameIndex: 4,
      timestampSec: 4.5,
      packages: [
        {
          customer: 'Microsoft',
          type: 'Removal',
          referenceNumber: 'Rem004891203',
          barcode: '7310048912034',
          quantity: 1,
          confidence: 'high',
        },
      ],
    },
    {
      frameIndex: 8,
      timestampSec: 8.0,
      packages: [
        {
          customer: 'Microsoft',
          type: 'Delivery',
          referenceNumber: 'Del001234567',
          barcode: '7310012345678',
          quantity: 1,
          confidence: 'high',
        },
      ],
    },
  ];

  const aggregated = aggregateVideoFrameDetections(slices);
  const merged = mergeInventoryItems([], aggregated);

  assert.equal(merged.length, 2);
  const msDel = merged.find((i) => i.referenceNumber === 'Del001234567');
  assert.ok(msDel);
  assert.equal(msDel.customer, 'Microsoft');
  assert.equal(msDel.quantity, 2);
});

test('uses optional user hint when a barcode-only label lacks printed customer name', () => {
  const detected = parseLabelFrame({
    frameIndex: 0,
    sourceKind: 'image',
    barcodes: [{ text: '7350089124501', format: 'EAN13' }],
    ocrText: '',
    ocrConfidence: 0,
    hint: 'Volvo Delivery',
  });

  assert.equal(detected.length, 1);
  assert.equal(detected[0].customer, 'Volvo');
  assert.equal(detected[0].type, 'Delivery');
  assert.equal(detected[0].referenceNumber, '7350089124501');
  assert.equal(detected[0].barcode, '7350089124501');
});
