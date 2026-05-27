'use strict';

function readChunkId(buffer, offset) {
  return buffer.toString('ascii', offset, offset + 4);
}

function getWavInfo(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }

  if (buffer.length < 44 || readChunkId(buffer, 0) !== 'RIFF' || readChunkId(buffer, 8) !== 'WAVE') {
    throw new Error('Unsupported WAV file: missing RIFF/WAVE header');
  }

  let offset = 12;
  let fmt = null;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = readChunkId(buffer, offset);
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;

    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(dataOffset),
        channels: buffer.readUInt16LE(dataOffset + 2),
        sampleRate: buffer.readUInt32LE(dataOffset + 4),
        byteRate: buffer.readUInt32LE(dataOffset + 8),
        blockAlign: buffer.readUInt16LE(dataOffset + 12),
        bitsPerSample: buffer.readUInt16LE(dataOffset + 14)
      };
    } else if (id === 'data') {
      dataSize = size;
      break;
    }

    offset = dataOffset + size + (size % 2);
  }

  if (!fmt || !dataSize) {
    throw new Error('Unsupported WAV file: missing fmt or data chunk');
  }

  const durationSeconds = dataSize / fmt.byteRate;
  return {
    ...fmt,
    dataSize,
    durationSeconds
  };
}

function wavDurationFrames(buffer, timelineFps) {
  const info = getWavInfo(buffer);
  return {
    ...info,
    durationFrames: Math.max(1, Math.ceil(info.durationSeconds * Number(timelineFps || 24)))
  };
}

module.exports = {
  getWavInfo,
  wavDurationFrames
};
