export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataSize: number;
  durationSeconds: number;
}

export interface WavDurationResult extends WavInfo {
  durationFrames: number;
}

function readChunkId(view: DataView, offset: number): string {
  let str = '';
  for (let i = 0; i < 4; i++) {
    str += String.fromCharCode(view.getUint8(offset + i));
  }
  return str;
}

export function getWavInfo(arrayBuffer: ArrayBuffer): WavInfo {
  const view = new DataView(arrayBuffer);
  
  if (arrayBuffer.byteLength < 44) {
    throw new Error('Unsupported WAV file: file too small');
  }

  if (readChunkId(view, 0) !== 'RIFF' || readChunkId(view, 8) !== 'WAVE') {
    throw new Error('Unsupported WAV file: missing RIFF/WAVE header');
  }

  let offset = 12;
  let fmt: Omit<WavInfo, 'dataSize' | 'durationSeconds'> | null = null;
  let dataSize = 0;

  while (offset + 8 <= arrayBuffer.byteLength) {
    const id = readChunkId(view, offset);
    const size = view.getUint32(offset + 4, true); // Little endian
    const dataOffset = offset + 8;

    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(dataOffset, true),
        channels: view.getUint16(dataOffset + 2, true),
        sampleRate: view.getUint32(dataOffset + 4, true),
        byteRate: view.getUint32(dataOffset + 8, true),
        blockAlign: view.getUint16(dataOffset + 12, true),
        bitsPerSample: view.getUint16(dataOffset + 14, true)
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
  } as WavInfo;
}

export function wavDurationFrames(arrayBuffer: ArrayBuffer, timelineFps: number = 24): WavDurationResult {
  const info = getWavInfo(arrayBuffer);
  return {
    ...info,
    durationFrames: Math.max(1, Math.ceil(info.durationSeconds * Number(timelineFps || 24)))
  };
}
