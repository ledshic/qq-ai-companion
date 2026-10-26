import { isPrivateChat } from '../chat-scope.js';
import type { EventControls } from './runtime.js';
// User-facing memory commands belong to the application, not the event engine.
export const eventControls:EventControls={
  matches:text=>['/清空个人长期记忆','/清空长期记忆','/清空记忆','/主动关心 开','/主动关心 关'].includes(text),
  handle(text,scope,store,now){
  const place=isPrivateChat(scope.chatId)?'本次私聊':'本群';
  if(text==='/清空个人长期记忆'){
    for(const saved of store.ownerScopes(scope.ownerId))store.clear(saved);
    store.clear(scope);
    return '已清空你在各聊天中的个人长期记忆；各聊天的短期上下文仍保留。';
  }
  if(text==='/主动关心 关'||text==='/主动关心 开'){
    store.setSettings(scope,{...store.settings(scope),proactive:text.endsWith('关')?'off':'on_presence',updatedAt:now});
    if(text.endsWith('关'))store.cancelScope(scope);
    return text.endsWith('关')?`已关闭你在${place}的主动关心。`:'已恢复主动关心偏好；当前仍是仅观察模式，不会主动发送。';
  }
  if(text==='/清空长期记忆'||text==='/清空记忆'){
    store.clear(scope);
    return text==='/清空长期记忆'?`已清空你在${place}的长期记忆（画像、互动记录与摘要）。`:`已清空你在${place}的会话和长期记忆（画像、互动记录与摘要）。`;
  }
}};
