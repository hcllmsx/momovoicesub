'use strict';

function parseTimelineFrameRate(value) {
  const raw = String(value || '').trim();
  const dropFrame = /\bDF\b/i.test(raw);
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return { fps: 24, nominalFps: 24, dropFrame: false, label: '24' };
  }

  const fps = Number.parseFloat(match[1]);
  return {
    fps,
    nominalFps: Math.round(fps),
    dropFrame,
    label: raw
  };
}

function parseTimecode(timecode) {
  const match = String(timecode || '').trim().match(/^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid timecode: ${timecode}`);
  }

  return {
    hours: Number.parseInt(match[1], 10),
    minutes: Number.parseInt(match[2], 10),
    seconds: Number.parseInt(match[3], 10),
    frames: Number.parseInt(match[5], 10),
    separator: match[4]
  };
}

function timecodeToFrames(timecode, frameRateSetting) {
  const rate = typeof frameRateSetting === 'object'
    ? frameRateSetting
    : parseTimelineFrameRate(frameRateSetting);
  const tc = parseTimecode(timecode);

  if (!rate.dropFrame) {
    return (((tc.hours * 60 + tc.minutes) * 60 + tc.seconds) * rate.nominalFps) + tc.frames;
  }

  const dropFrames = Math.round(rate.nominalFps * 0.066666);
  const totalMinutes = (tc.hours * 60) + tc.minutes;
  const droppedFrames = dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
  return (((tc.hours * 3600) + (tc.minutes * 60) + tc.seconds) * rate.nominalFps) + tc.frames - droppedFrames;
}

function currentTimecodeToRecordFrame(currentTimecode, startTimecode, frameRateSetting, timelineStartFrame = 0) {
  const current = timecodeToFrames(currentTimecode, frameRateSetting);
  const start = timecodeToFrames(startTimecode || '00:00:00:00', frameRateSetting);
  return Math.max(0, Math.round(Number(timelineStartFrame || 0) + current - start));
}

module.exports = {
  parseTimelineFrameRate,
  parseTimecode,
  timecodeToFrames,
  currentTimecodeToRecordFrame
};
