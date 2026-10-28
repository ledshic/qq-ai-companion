import { profileDomain } from './domains/profile.js';
import { createArchiveSummarizer } from './summarize.js';
import { createInitiativeObserver } from './initiative.js';
import { createRecallSelector } from './recall.js';
import { createPersonalRecall, createPrivateDisclosure } from './personal-recall.js';
import { presentPersonalRecall } from './domains/event-recall.js';
import { eventConfig } from './config.js';
import { EventStore } from './store.js';
import { EventMemoryRuntime } from './runtime.js';
import { createEventExtractor } from './extractor.js';
import { createEventDomain } from './domains/event.js';
import { contactDomain, type ContactPayload } from './domains/contact.js';
import { eventControls } from './controls.js';
// Application composition owns domain registration. The runtime has no business branches.
export const createEventMemory=(env:NodeJS.ProcessEnv,log:(line:string)=>void=console.log):EventMemoryRuntime|undefined=>{
  const config=eventConfig(env);
  if(!config)return;
  if(env.LLM_ENABLED!=='true'||!env.DEEPSEEK_API_KEY)throw Error('事件记忆需要已启用的模型配置');
  let store:EventStore|undefined;
  try{
    store=new EventStore(env.MEMORY_DB||'data/memory.db');
    const runtime=new EventMemoryRuntime(store,[createEventDomain(),contactDomain,profileDomain],
      createEventExtractor(env.DEEPSEEK_API_KEY,env.DEEPSEEK_MODEL||'deepseek-flash'),config,eventControls,
      (records,settings)=>{
        const contactRecord=records.find(r=>r.domain===contactDomain.name);
        const contact=contactRecord?.payload as ContactPayload|undefined;
        const preference=typeof settings.updatedAt==='number'&&settings.updatedAt>=(contactRecord?.updatedAt??0)
          ?settings.proactive:contact?.proactive;
        return preference==='off'?{reason:'preference_off',terminal:true}:undefined;
      },Date.now,Math.random,log,createPersonalRecall(store,createRecallSelector(env.DEEPSEEK_API_KEY,env.DEEPSEEK_MODEL||'deepseek-flash'),presentPersonalRecall,config.groups,createPrivateDisclosure(env.DEEPSEEK_API_KEY,env.DEEPSEEK_MODEL||'deepseek-flash')),createInitiativeObserver(env.DEEPSEEK_API_KEY,env.DEEPSEEK_MODEL||'deepseek-flash',env.PERSONALITY_MODE||'legacy'),createArchiveSummarizer(env.DEEPSEEK_API_KEY,env.DEEPSEEK_MODEL||'deepseek-flash'));
    log(`[事件记忆] mode=observe; scope=${config.scope}; groups=${config.groups.size}; send=false; recall=personal; retention=permanent; archive=enabled; private=enabled; initiative=observe`);
    return runtime;
  }catch{store?.close();log('[事件记忆] disabled=initialization_error');return;}
};
