import { describe, expect, it } from 'vitest';
import { lacing, oggCrc, oggPage, opusPacketSamples, PAGE_BOS, silenceFramesForGap } from '../src/recording/ogg.js';

describe('OGG/Opus', () => {
  it('CRC32 Ogg (vecteur de référence « 123456789 » = 0x89A1897F)', () => {
    expect(oggCrc(Buffer.from('123456789'))).toBe(0x89a1897f);
  });

  it('une page porte un CRC qui se vérifie', () => {
    const page = oggPage([Buffer.from('OpusHead-test')], { serial: 42, sequence: 0, granule: 0n, flags: PAGE_BOS });
    const stored = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    expect(oggCrc(page)).toBe(stored);
    expect(page.subarray(0, 4).toString()).toBe('OggS');
    expect(page.readUInt8(5)).toBe(PAGE_BOS);
  });

  it('table de laçage', () => {
    expect(lacing(3)).toEqual([3]);
    expect(lacing(255)).toEqual([255, 0]);
    expect(lacing(600)).toEqual([255, 255, 90]);
  });

  it('échantillons par paquet selon le TOC', () => {
    expect(opusPacketSamples(Buffer.from([0xf8, 0xff, 0xfe]))).toBe(960); // CELT FB 20 ms, 1 trame
    expect(opusPacketSamples(Buffer.from([0x78]))).toBe(960); // hybride FB 20 ms (config 15)
    expect(opusPacketSamples(Buffer.from([0xf9]))).toBe(1920); // 2 trames de 20 ms
    expect(opusPacketSamples(Buffer.from([0xfb, 0x03]))).toBe(2880); // code 3 : 3 trames
  });

  it('comblement des pauses', () => {
    expect(silenceFramesForGap(20)).toBe(0);
    expect(silenceFramesForGap(60)).toBe(0); // gigue réseau tolérée
    expect(silenceFramesForGap(520)).toBe(25); // 500 ms de silence
  });
});
