import type { EventConfig } from './types.js';
export const eventConfig=(env:NodeJS.ProcessEnv):EventConfig|undefined=>{
  if(env.EVENT_MEMORY_ENABLED!==undefined&&!['true','false'].includes(env.EVENT_MEMORY_ENABLED))throw Error('EVENT_MEMORY_ENABLED 必须为 true 或 false');
  const mode=env.EVENT_FOLLOWUP_MODE??'off';
  if(!['off','observe'].includes(mode))throw Error('本阶段 EVENT_FOLLOWUP_MODE 只支持 off 或 observe，不能主动发送');
  const scope=env.EVENT_MEMORY_SCOPE??'addressed';
  if(scope!=='addressed'&&scope!=='group')throw Error('EVENT_MEMORY_SCOPE 必须为 addressed 或 group');
  if(env.EVENT_MEMORY_ENABLED!=='true'||mode==='off')return;
  const groups=(env.EVENT_MEMORY_GROUPS??'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!groups.length||groups.some(g=>!/^\d+$/.test(g)))throw Error('启用事件记忆必须明确 EVENT_MEMORY_GROUPS 群号列表');
  return {groups:new Set(groups),scope,mode:'observe'};
};
