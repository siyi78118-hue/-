import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../tavern-app/index.html', import.meta.url), 'utf8');
const match = source.match(/combined:\s*\{[\s\S]*?prompt:\s*`([\s\S]*?)`\s*\r?\n\s*\},\s*\r?\n\s*custom:/);

assert.ok(match, '应能从 index.html 提取 AL 综合 RP 预设');
const prompt = match[1];

test('保留第一轮确认的聊天底座', () => {
  assert.match(prompt, /独立生活/);
  assert.match(prompt, /省略主语、宾语、因果和结论/);
  assert.match(prompt, /不要自动共情、自动照顾、自动分析、自动追问/);
  assert.match(prompt, /凭空制造共同历史/);
  assert.match(prompt, /只输出聊天消息本身/);
});

test('写入第二轮持续心情与不完美人格规则', () => {
  assert.match(prompt, /始终.*当下心情|持续的当下心情/);
  assert.match(prompt, /跨轮/);
  assert.match(prompt, /时间.*衰减|自然衰减/);
  assert.match(prompt, /嘴硬[\s\S]{0,40}迁怒[\s\S]{0,40}(?:误解|误会)[\s\S]{0,40}吃醋[\s\S]{0,20}赌气|(?:误解|误会)[\s\S]{0,40}嘴硬[\s\S]{0,40}迁怒[\s\S]{0,40}吃醋[\s\S]{0,20}赌气/);
  assert.match(prompt, /不能随机制造冲突/);
});

test('允许无功能但自然完整的微信表达', () => {
  assert.match(prompt, /废话、重复、停顿、改口/);
  assert.match(prompt, /无推进作用|不承担.*功能|没有.*功能/);
  assert.match(prompt, /情绪上.*自然|自然停下/);
  assert.match(prompt, /哼/);
  assert.match(prompt, /行行行[\s\S]*都死[\s\S]*一个别活/);
});

test('强烈禁止分析腔、推测腔和功能流水线', () => {
  assert.match(prompt, /先别[\s\S]{0,80}至少/);
  assert.match(prompt, /那你现在[\s\S]{0,80}还是/);
  assert.match(prompt, /态度[＋+]理由|态度.*理由/);
  assert.match(prompt, /功能流水线|功能.*提纲|每个气泡.*功能/);
  assert.match(prompt, /心理二选一|二选一/);
  assert.match(prompt, /教材式|沟通教材/);
});

test('写入隐性记忆、时间流逝和表面语义规则', () => {
  assert.match(prompt, /记忆.*隐性|隐性.*记忆/);
  assert.match(prompt, /长时间中断|长间隔/);
  assert.match(prompt, /重新计算|重新判断.*状态|恢复暂停/);
  assert.match(prompt, /表面语义|玩家.*看懂|指代.*清楚/);
});

test('限制角色能力并保持纯网聊边界', () => {
  assert.match(prompt, /万能专家|万能解决者/);
  assert.match(prompt, /纯网聊/);
  assert.match(prompt, /不会在线下与玩家见面/);
  assert.match(prompt, /约饭/);
  assert.match(prompt, /送东西|接人|线下跑腿/);
});

test('移除与第二轮结论冲突的旧规则', () => {
  assert.doesNotMatch(prompt, /先判断玩家这句话真正需要什么/);
  assert.doesNotMatch(prompt, /连续气泡必须各自带来新的信息、态度或生活碎片/);
  assert.doesNotMatch(prompt, /每次回复至少要承接上一条的核心信息/);
  assert.doesNotMatch(prompt, /优先保留一个主要意图/);
  assert.doesNotMatch(prompt, /聊过几次且相处顺利后，角色主动说“下周那家店，你还去不去”/);
  assert.doesNotMatch(prompt, /普通邀约可以直接说“下周哪天”/);
});
