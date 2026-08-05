'use strict';

function friendlyErrorMessage(error) {
  let message = typeof error === 'string' ? error : (error && error.message) || '操作失败。';
  message = message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '');

  // ─── 网络 / 云端 API 类错误 ───
  if (/Body is unusable|Body has already been read/i.test(message)) {
    return '云端请求异常，请稍后重试。';
  }
  if (/Failed to fetch|fetch failed|NetworkError/i.test(message)) {
    return '网络连接失败，请检查网络后重试。';
  }
  if (/ECONNREFUSED/i.test(message)) {
    return '无法连接到服务器，请检查网络连接。';
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed?\s*out/i.test(message)) {
    return '请求超时，请稍后重试。';
  }
  if (/ENOTFOUND/i.test(message)) {
    return '无法解析服务器地址，请检查网络或 DNS 设置。';
  }
  if (/socket hang up|ECONNRESET/i.test(message)) {
    return '网络连接被中断，请稍后重试。';
  }
  if (/underrun|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout/i.test(message)) {
    return '云端服务暂时不可用，请稍后重试。';
  }
  if (/TOKEN_EXPIRED|NOT_LOGGED_IN/i.test(message)) {
    return '云端登录已过期，请重新登录。';
  }
  if (/NO_REFRESH_TOKEN/i.test(message)) {
    return '登录状态已失效且无法自动续期，请重新登录。';
  }
  if (/BANNED/i.test(message)) {
    return '账号已被封禁，请联系管理员。';
  }
  if (/quota|配额|额度/i.test(message)) {
    return '云端配音额度已用尽，请升级套餐或稍后重试。';
  }
  if (/合成失败.*\((\d+)\)/.test(message)) {
    return message.replace(/合成失败.*\((\d+)\)/, (m, code) => {
      const map = {
        '400': '云端请求参数错误（400），请检查文本或音色设置。',
        '401': '云端登录已过期，请重新登录。',
        '403': '云端账号无权限，可能已被封禁。',
        '429': '云端请求过于频繁，请稍后重试。',
        '500': '云端服务器内部错误（500），请稍后重试。',
        '502': '云端网关错误（502），请稍后重试。',
        '503': '云端服务暂时不可用（503），请稍后重试。',
        '504': '云端网关超时（504），请稍后重试。',
      };
      return map[code] || `云端合成失败（${code}），请稍后重试。`;
    });
  }

  // ─── DaVinci Resolve / 时间线类错误 ───
  if (/No current timeline/i.test(message)) {
    return '当前项目没有选中的时间线。请先创建并打开一条时间线。';
  }
  if (/No current Resolve project/i.test(message)) {
    return '当前没有打开项目。请先打开或创建一个项目。';
  }
  if (/GetCurrentTimecode|Not supported on current page/i.test(message)) {
    return '当前页面不能读取播放头位置。请切换到"快编"或"剪辑"页面后再插入配音。';
  }
  if (/Failed to import audio/i.test(message)) {
    return message.replace(/Failed to import audio:/i, '导入音频失败：');
  }
  if (/Failed to append audio to timeline/i.test(message)) {
    return '音频已生成，但插入时间线失败。请检查目标音频轨是否锁定或不可用。';
  }
  if (/Azure Speech key is required/i.test(message)) {
    return '请先在设置中填写 密钥。';
  }
  if (/Azure region or endpoint is required/i.test(message)) {
    return '请先在设置中填写 位置/区域。';
  }

  return message;
}

module.exports = {
  friendlyErrorMessage
};
