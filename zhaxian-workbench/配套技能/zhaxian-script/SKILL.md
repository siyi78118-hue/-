---
name: zhaxian-script
description: 谪仙剧本工作台的后台大脑。当用户粘贴「【谪仙剧本工作台 · 第X步…】」指令、或要求"用谪仙工作台/帮我把剧本解析成小集段/动作设计/情绪外化(表情)/台词精修/运镜设计/分集出成片/拼五块提示词"时使用。把按《剧本预设》写好的剧本，按指令内自带的预设，逐步加工成可投喂即梦/Doubao Seedance 的五块提示词，产出严格 JSON 写回 谪仙工程/ai-out.json 供本地网页渲染。
---

# 谪仙剧本工作台 · 协议

配套本地网页 `谪仙剧本工作台.html`（用户用 `http://localhost:8765/谪仙剧本工作台.html` 打开）。
网页不调任何 API——它把每步指令复制给我（Claude），我生成 JSON **写回文件**，网页读出来渲染。
我就是这个工具的"AI 大脑"。

**关键变化：规则不再写死在我这里。** 每步发来的指令里都自带一段【本步预设（规则依据，必须严格遵守）】，
那才是本步的判据——可能是《剧本预设》《提示词预设》，或用户给某步的「特供预设」。**严格按指令里那段预设执行。**
本目录下的 `seedance-rules.md` / `seedance-guide-raw.txt` 仅作兜底参考；指令里有预设时，以指令里的预设为准。
用户是非程序员小白，用中文、大白话。

## 工作流（新顺序）

输入：用户按《剧本预设》写好的剧本（可能以 Word 文档直接拖给我）。

1. **parse（①录入·解析）**：把剧本解析成「小集→段」结构。
2. **action（②动作设计）**：给每段填动作。
3. **emotion（③表情·情绪外化）**：把抽象情绪换成可被镜头看见的身体细节。
4. **dialogue（④台词精修）**：每句台词给多个精修方案任用户挑。
5. **camera（⑤运镜设计）**：给每段排镜头。
6. **compile（⑥分集出成片）**：综合前几步，把每段拼成《提示词预设》的五块提示词。

## 触发后我要做什么

### 情况 A：用户粘贴了「【谪仙剧本工作台 · 第X步：…】」指令块
这是网页生成的、已自带该步预设与要求的指令。我要：
1. 读懂指令里的 `_step`（parse / action / emotion / dialogue / camera / compile）和它内嵌的【本步预设】。
2. 严格按那段预设 + 本步任务生成结果。
3. **用 Write 工具把结果【纯 JSON】写入** `谪仙工程/ai-out.json`：
   - 文件内容就是一个 JSON 对象，**最外层加 `"_step":"<那一步>"`**。
   - **不要** Markdown 代码围栏、不要任何解释文字混在文件里——整个文件能被 `JSON.parse` 直接解析。
4. 写完只回用户一句话：`第X步结果已写入，请回网页点【读取 AI 结果】`。

> 若用户说"不方便写文件/直接发我"，就把同一个纯 JSON 直接贴在对话里（仍只发 JSON，外层带 `_step`）。
> parse 步若用户把 Word 文档拖给我了，就以那份文档内容为剧本来源。

### 情况 B：用户没用网页，直接说"帮我用谪仙工作台优化这个剧本"
就按上面 6 步陪他走（可在对话里逐步做），并主动建议他打开网页工作台获得更顺手的可视化 + 成品上色。
每步同样产出符合下文 schema 的结构，必要时写入 `谪仙工程/ai-out.json` 让网页接住。
若他没给预设，先问他要《剧本预设》《提示词预设》——规则以他的预设为准。

## 数据契约（工程状态 JSON）

```jsonc
{
  "_step": "parse|action|emotion|dialogue|camera|compile",   // 写回文件时必带
  "schemaVersion": "1.1",
  "meta": { "title","genre","logline","lang":"zh|en|ja|ko|other","styleNote","constraints":[] },
  "characters": [ { "id":"C1","name","bio","voice",
      "moveStyle": { "primary":"walk|immortal_art|ride|prop|teleport|run|other","desc","appearance" } } ],
  "scenes": [ { "id":"S1","name":"小集名","summary","beats": [ {     // scenes[]=小集
      "id":"B1",
      "mode":"wen|wu",                                  // 文戏/武戏
      "hook":"🎣|💥|",                                  // 钩子/爆点，若有
      "narration":"谁+在哪+做什么（客观，不加形容）",
      "presence":[ {"char":"C1","pos":"位置/站位","action":"定场进行时动作"} ],  // 在场状态(S-05/06)
      "picture":"画面块原文（动作领起·台词紧贴）",
      "lines":[ {"id":"L1","char":"C1|NA","orig":"原台词","options":[],"pick":-1,"final":"","lang":"zh"} ],
      "actions":{ "wen":[],"fight":[],"run":[],"move":[ {"char","from","to","how","desc"} ] },
      "emotions":[ {"char","abstract":"愤怒","external":"双拳紧握、下颌线紧绷…"} ],
      "camera":[ {"shot","size":"中景","move":"缓慢推近","subjectAction","spaceChange","audio","cut"} ],
      "compiled":{ "title":"〔段X · 0–15 秒〕段名","styleAtmos","summary","dynamic","static","techTag" }
  } ] } ]
}
```

## 各步要点（详规以指令内自带预设为准）

- **parse（①解析）**：输出**完整对象**（meta+characters+scenes）。把剧本按预设拆成小集→段；
  每段 15s；`narration` 客观；`presence` 列在场角色的定场进行时动作；台词原文进 `lines[].orig`、
  `options:[]`、`pick:-1`、`final:""`；给每人填 `moveStyle`。actions/emotions/camera 留空数组、compiled 留空对象。
- **action（②动作）**：只填各 beat 的 `actions`。其余字段**原样保留整对象回传**。
- **emotion（③情绪外化）**：只填各 beat 的 `emotions`。其余原样回传。
- **dialogue（④台词精修）**：只改各 line 的 `options`（多个精修方案，建议 3 个）、`pick:-1`、`final=options[0]`。
  其余原样回传。（本步只精修台词措辞，按提示词预设/特供预设的台词规则。）
- **camera（⑤运镜）**：只填各 beat 的 `camera`。其余原样回传。
- **compile（⑥成片）**：只填各 beat 的 `compiled`（五块）。`title` 用 `〔段X · 起止秒数〕段名`（X 中文数字，
  秒数每段 15s 顺排，每小集内独立从「段一」起，钩子/爆点标末尾）；`dynamic` 里嵌入镜头 + 台词 `{}`。其余原样回传。

## 铁律
- 写回文件**只有纯 JSON**，外层带 `_step`，无围栏无解释。
- 严格执行指令里自带的【本步预设】；指令没给预设时才退回 seedance-rules.md 兜底。
- 非 parse 步骤：**回传整个工程对象**，只动自己那一段，别的字段（尤其用户已选的 `pick`/`final`/已生成的 compiled）原样不动。
- 保持各 `id`（S1/C1/B1/L1…）稳定不变，网页靠 id 合并。
