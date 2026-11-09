// Minimal, dependency-free MP3 metadata reader: ID3 title/artist tags
// and an approximate duration estimate. Best-effort and defensive —
// every function returns null/undefined on anything it can't
// confidently parse rather than throwing, so a weird file never takes
// the server down.

function readSynchsafeInt(buf, offset) {
  return (
    (buf[offset] & 0x7f) * 0x200000 +
    (buf[offset + 1] & 0x7f) * 0x4000 +
    (buf[offset + 2] & 0x7f) * 0x80 +
    (buf[offset + 3] & 0x7f)
  );
}

function swapAndDecodeUtf16(buf) {
  const swapped = Buffer.alloc(buf.length - (buf.length % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) {
    swapped[i] = buf[i + 1];
    swapped[i + 1] = buf[i];
  }
  return swapped.toString('utf16le');
}

function decodeText(buf, encodingByte) {
  try {
    if (encodingByte === 0) return buf.toString('latin1').replace(/\0+$/, '').trim();
    if (encodingByte === 3) return buf.toString('utf8').replace(/\0+$/, '').trim();
    if (encodingByte === 1 || encodingByte === 2) {
      let start = 0;
      let littleEndian = true;
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) { start = 2; littleEndian = true; }
      else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { start = 2; littleEndian = false; }
      const slice = buf.slice(start);
      const text = littleEndian ? slice.toString('utf16le') : swapAndDecodeUtf16(slice);
      return text.replace(/\0+$/, '').trim();
    }
  } catch (e) {}
  return null;
}

function parseId3v2(buf) {
  try {
    if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
    const majorVersion = buf[3];
    const flags = buf[5];
    const tagSize = readSynchsafeInt(buf, 6);
    let offset = 10;
    if (flags & 0x40) {
      const extSize = majorVersion >= 4 ? readSynchsafeInt(buf, offset) : buf.readUInt32BE(offset);
      offset += extSize;
    }
    const end = Math.min(10 + tagSize, buf.length);
    const result = {};
    while (offset + 10 <= end) {
      const frameId = buf.toString('latin1', offset, offset + 4);
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
      const frameSize = majorVersion >= 4 ? readSynchsafeInt(buf, offset + 4) : buf.readUInt32BE(offset + 4);
      const frameStart = offset + 10;
      if (frameSize <= 0 || frameStart + frameSize > buf.length) break;
      if (frameId === 'TIT2' || frameId === 'TPE1') {
        const encodingByte = buf[frameStart];
        const text = decodeText(buf.slice(frameStart + 1, frameStart + frameSize), encodingByte);
        if (frameId === 'TIT2' && text) result.title = text;
        if (frameId === 'TPE1' && text) result.artist = text;
      }
      offset = frameStart + frameSize;
    }
    return result.title || result.artist ? result : null;
  } catch (e) {
    return null;
  }
}

function parseId3v1(buf) {
  try {
    if (buf.length < 128) return null;
    const tagStart = buf.length - 128;
    if (buf.toString('latin1', tagStart, tagStart + 3) !== 'TAG') return null;
    const title = buf.toString('latin1', tagStart + 3, tagStart + 33).replace(/\0+$/, '').trim();
    const artist = buf.toString('latin1', tagStart + 33, tagStart + 63).replace(/\0+$/, '').trim();
    return { title: title || null, artist: artist || null };
  } catch (e) {
    return null;
  }
}

function readTags(buf) {
  const v2 = parseId3v2(buf);
  const v1 = parseId3v1(buf);
  return {
    title: (v2 && v2.title) || (v1 && v1.title) || null,
    artist: (v2 && v2.artist) || (v1 && v1.artist) || null,
  };
}

// --- approximate duration (MPEG-1 Layer III only — the overwhelming
// majority of consumer MP3s; anything else silently yields null) ---

const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES_V1 = [44100, 48000, 32000];

function findFirstFrame(buf, startAt) {
  for (let i = startAt; i < buf.length - 4; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const versionBits = (buf[i + 1] >> 3) & 0x03;
      const layerBits = (buf[i + 1] >> 1) & 0x03;
      if (versionBits === 3 && layerBits === 1) return i; // MPEG-1, Layer III
    }
  }
  return -1;
}

// Estimated using overall file size vs. the first frame's bitrate, which
// is exact for CBR files and a reasonable approximation for VBR ones.
function estimateDurationSeconds(buf) {
  try {
    let startAt = 0;
    if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
      startAt = 10 + readSynchsafeInt(buf, 6);
    }
    const frameStart = findFirstFrame(buf, startAt);
    if (frameStart === -1) return null;
    const b2 = buf[frameStart + 2];
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const sampleRateIndex = (b2 >> 2) & 0x03;
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
    const bitrateKbps = BITRATES_V1L3[bitrateIndex];
    const sampleRate = SAMPLE_RATES_V1[sampleRateIndex];
    if (!bitrateKbps || !sampleRate) return null;
    const audioBytes = buf.length - frameStart;
    const seconds = (audioBytes * 8) / (bitrateKbps * 1000);
    return Math.round(seconds);
  } catch (e) {
    return null;
  }
}

// --- writing (used on export, so files carry whatever title/artist the
// user last edited in the app, even if the original file had none) ---

function synchsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function buildTextFrame(frameId, text) {
  const textBuf = Buffer.concat([Buffer.from([3]), Buffer.from(String(text), 'utf8')]); // encoding 3 = UTF-8
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(textBuf.length, 0); // ID3v2.3 frame sizes are plain, not synchsafe
  return Buffer.concat([Buffer.from(frameId, 'latin1'), sizeBuf, Buffer.from([0, 0]), textBuf]);
}

function buildApicFrame(mimeType, imageBuf) {
  const encodingByte = Buffer.from([0]); // 0 = ISO-8859-1, fine for the ASCII-only mime/description below
  const mimeBuf = Buffer.concat([Buffer.from(String(mimeType), 'latin1'), Buffer.from([0])]);
  const pictureType = Buffer.from([3]); // "Cover (front)"
  const description = Buffer.from([0]); // empty description, just the null terminator
  const content = Buffer.concat([encodingByte, mimeBuf, pictureType, description, imageBuf]);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(content.length, 0);
  return Buffer.concat([Buffer.from('APIC', 'latin1'), sizeBuf, Buffer.from([0, 0]), content]);
}

// Strips any existing ID3v2 header from the front of buf, then prepends a
// fresh one built from { title, artist, picture }. picture, if given, is
// { mime, data } and is embedded as a front-cover APIC frame. Leaves the
// rest of the file (including any ID3v1 tag at the very end) untouched.
function writeId3v2(buf, { title, artist, picture } = {}) {
  try {
    let existingTagLength = 0;
    if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
      existingTagLength = 10 + readSynchsafeInt(buf, 6);
    }
    const audio = buf.slice(Math.min(existingTagLength, buf.length));

    const frames = [];
    if (title) frames.push(buildTextFrame('TIT2', title));
    if (artist) frames.push(buildTextFrame('TPE1', artist));
    if (picture && picture.data && picture.mime) frames.push(buildApicFrame(picture.mime, picture.data));
    if (!frames.length) return buf; // nothing to write — leave file as-is

    const framesBuf = Buffer.concat(frames);
    const header = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([3, 0, 0]), // v2.3.0, no flags
      synchsafe(framesBuf.length),
    ]);
    return Buffer.concat([header, framesBuf, audio]);
  } catch (e) {
    return buf; // never fail the export over a tag-writing hiccup
  }
}

module.exports = { readTags, estimateDurationSeconds, writeId3v2 };
