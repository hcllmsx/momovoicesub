'use strict';

function friendlyErrorMessage(error) {
  let message = typeof error === 'string' ? error : (error && error.message) || '操作失败。';
  message = message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '');

  if (/No current timeline/i.test(message)) {
    return '当前项目没有选中的时间线。请先创建并打开一条时间线。';
  }
  if (/No current Resolve project/i.test(message)) {
    return '当前没有打开项目。请先打开或创建一个项目。';
  }
  if (/GetCurrentTimecode|Not supported on current page/i.test(message)) {
    return '当前页面不能读取播放头位置。请切换到“快编”或“剪辑”页面后再插入配音。';
  }
  if (/Failed to import audio/i.test(message)) {
    return message.replace(/Failed to import audio:/i, '导入音频失败：');
  }
  if (/Failed to append audio to timeline/i.test(message)) {
    return '音频已生成，但插入时间线失败。请检查目标音频轨是否锁定或不可用。';
  }
  if (/Azure Speech key is required/i.test(message)) {
    return '请先在设置中填写 Azure Speech Key。';
  }
  if (/Azure region or endpoint is required/i.test(message)) {
    return '请先在设置中填写 Azure 区域或 Endpoint。';
  }

  return message;
}

module.exports = {
  friendlyErrorMessage
};
