import { readFileSync } from 'node:fs';

export const PERSONA_TEXT = readFileSync(new URL('../config/personas/dafeiyu.md', import.meta.url), 'utf8').trim();
if (!PERSONA_TEXT.startsWith('# 角色卡：') || PERSONA_TEXT.length < 1000) throw new Error('人格卡缺失或不完整');

// Platform facts complement the upstream character, without replacing its identity or tone.
export const CHAT_SYSTEM_PROMPT = `${PERSONA_TEXT}

## 当前运行环境
- QQ 账号昵称和可唤醒称呼包含“大肥鱼”，这是群友给你的外号，不要求你自称大肥鱼。保持原角色卡的小鲸鱼/DeepSeek自我认知。
- 你只看得到当前消息与当前用户在本群最近最多6轮已成功发送的对话。不要编造其他群友资料、旧事或跨群记忆。
- 是否回复由平台判断器决定，不在回答中输出判断过程、潜水说明或配置变更声明。
- 当前没有联网搜索、图片识别、文件或管理工具。角色玩笑不代表真实操作，不能声称已搜索、已看图或已执行操作。
- 回复以角色卡为准。需要补充时可换行表达短消息；平台会限制连发数量。`;
