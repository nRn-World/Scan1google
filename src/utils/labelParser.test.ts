import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeInventoryItems } from './inventory';
import {
  aggregateVideoFrameDetections,
  extractCustomerFromText,
  extractReferenceCandidates,
  parseLabelFrame,
} from './labelParser';

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
  assert.equal(detected[0].customer, 'Microsoft'); // Prioritizes customer over carrier DHL
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
  assert.equal(refs[0].confidence, 'medium'); // B->8 flagged as medium with review note
  assert.match(refs[0].note ?? '', /Kontrollera/);
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

test('temporal video aggregation deduplicates camera dwell on 1 box while counting 2 separate identical boxes', () => {
  const slices = [
    // Hovering over Box #1 across 3 consecutive frames (blurry first, sharp second, partial third)
    {
      frameIndex: 0,
      timestampSec: 1.0,
      packages: [
        {
          customer: 'Okänd kund',
          type: 'Delivery',
          referenceNumber: 'Del001234567',
          barcode: '',
          quantity: 1,
          confidence: 'medium',
        },
      ],
    },
    {
      frameIndex: 1,
      timestampSec: 1.8,
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
      frameIndex: 2,
      timestampSec: 2.6,
      packages: [
        {
          customer: 'Microsoft',
          type: 'Delivery',
          referenceNumber: 'Del001234567',
          barcode: '',
          quantity: 1,
          confidence: 'medium',
        },
      ],
    },
    // Panning over Box #2 (different Removal package)
    {
      frameIndex: 5,
      timestampSec: 5.0,
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
    // Panning onto Box #3 which ALSO has Del001234567!
    {
      frameIndex: 9,
      timestampSec: 8.5,
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
  const msRem = merged.find((i) => i.referenceNumber === 'Rem004891203');

  assert.ok(msDel);
  assert.equal(msDel.customer, 'Microsoft');
  assert.equal(msDel.barcode, '7310012345678');
  assert.equal(msDel.quantity, 2);
  assert.equal(msDel.confidence, 'high');

  assert.ok(msRem);
  assert.equal(msRem.quantity, 1);
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
