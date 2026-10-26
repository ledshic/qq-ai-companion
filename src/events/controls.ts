import type { EventControls } from './runtime.js';
// User-facing memory commands belong to the application, not the event engine.
export const eventControls:EventControls={
  matches:text=>['/清空长期记忆','/清空记忆','/主动关心 开','/主动关心 关'].includes(text),
  handle(text,scope,store,now){
  if(text==='/主动关心 关'||text==='/主动关心 开'){
    store.setSettings(scope,{...store.settings(scope),proactive:text.endsWith('关')?'off':'on_presence',updatedAt:now});
    if(text.endsWith('关'))store.cancelScope(scope);
    return text.endsWith('关')?'已关闭你在本群的主动关心。':'已恢复主动关心偏好；当前仍是仅观察模式，不会主动发送。';
  }
  if(text==='/清空长期记忆'||text==='/清空记忆'){
    store.clear(scope);
    return text==='/清空长期记忆'?'已清空你在本群的长期事件记忆。':'已清空你在本群的会话和长期事件记忆。';
  }
}};
