# 豆瓣数据审阅与实现清单

> **历史接口采样。** 不是现版路由、可用率或真实 UI 的证明；现版覆盖见 [Windows](frontend-audit-windows.md)、[TV](frontend-audit-tv.md) 和 [证据核验](ui-evidence-review.md)。

审阅日期：2026-11-16。只读检查 `见界/src-tauri/src/douban.rs`、`见界/prototype/src/douban.ts`、根 AGENTS、Cargo 配置及数据源决策；完整检查 Panda `design/contract/{types,rules,constants,copy}.ts`。Panda 现有契约没有生产后端。原型与见界文件未修改。

## 真实接口验证

可重放：`node docs/evidence/probe-douban.mjs`。两轮结果写入 [脱敏证据](evidence/douban-audit.json)，每个结果含请求、HTTP 状态、耗时、字段集合、少量内容身份；不存 Cookie、媒体签名地址、用户资料或完整上游响应。

| 用途 | 官方端点 | 已观测结果与实现选择 |
| --- | --- | --- |
| 首页列表 | movie.douban.com/j/search_subjects | 正常返回 subjects；仅包含标题、评分、封面、更新字串等简要字段。 |
| 频道、筛选、分页 | m.douban.com/rexxar/api/v2/{movie,tv}/recommend | 正常返回 items/categories/sorts；优先作为生产列表源，拥有年份、地区、类型、剧照。过滤 chart/doulist/推广卡。游标使用上游 start/count，不能用过滤后的数组长度。 |
| 搜索、联想 | m.douban.com/rexxar/api/v2/search/movie | `q=三体` 返回 20 条真实结果，条目在 target，媒体类型在 target_type。筛除非 movie/tv 结果，保留同名不同作品；联想取前 8，输入防抖。 |
| 旧联想 | movie.douban.com/j/subject_suggest | 官方与见界反代对“三体”和官方对“Interstellar”返回空数组；不能作为唯一生产搜索。 |
| 详情 | m.douban.com/rexxar/api/v2/{movie,tv}/{id} | 三体真实返回评分 8.8、30 集元数据、45 分钟、简介、导演演员、年份地区；评分与时长仅显示原始值，绝不用于模拟播放器时间。 |
| 演职员角色 | .../{id}/celebrities（2026-11-17 起改用 .../{id}/credits，见文末“演职员与影人作品”） | 正常返回 actors/directors；演员 character 可映射原型 role（实测张鲁一“饰 汪淼”）。 |
| 剧照 | .../{id}/photos?count=8 | 选择真实横图；缺失返回 null，UI 按契约使用海报，无默认假图。 |
| 相关推荐 | .../{id}/recommendations?count=14 | 电影与电视剧均返回真实推荐数组；`related_subjects` 实测是原著书籍等关联资料，不适合作为影视推荐。 |
| 排行榜 | .../subject_collection/{collection}/items | movie_real_time_hotest、movie_weekly_best、tv_hot 可用，保留官方榜名和顺序。 |
| 热搜 | 豆瓣无影视专用端点；改用 top.baidu.com/api/board（tab=movie、teleplay） | 豆瓣 `/search/hot_queries`、`/search/hot_searches`、`/search/hot_search` 返回 404；`/search/hots` 为 200，但只有全站 gallery_topics，type/category 参数被忽略。生产用百度电影榜与电视剧榜的官方 JSON：校验榜单标识 `fyb_movie`/`fyb_teleplay` 与“热搜指数”字段，两榜按指数合并去重取前 10；任一校验不过即报错并可重试，不返回写死的词。见下文复审。 |

接口无需注入个人 Cookie 或公开移动端 key。40 次审计请求中，首轮 channel-movie 网络失败，第二轮同请求在 788ms 成功；其余核心端点两轮成功，旧联想两轮空，候选热搜两轮 404。官方域名目前工作正常；反代具有第三方可用性和数据一致性风险，不作为默认信任路径。一次/两次成功不能保证长期稳定，发行报告应保留此限制。

## 字段与筛选注意事项

- `card_subtitle`：推荐/相关推荐为“年份 / 地区 / 类型 / 导演 / 演员”，搜索为“地区 / 类型 / 导演 / 演员”；解析需判断首段，不可复用固定下标。名字内部空格不拆成多人；列表只提取可靠的年份、地区、类型，正式演职员从详情/credits 获取。
- `score` 仅接受有限数值且 `0 < value <= 10`；年只接受明确四位数；空原名、导演、角色、简介等直接省略，图字段使用 null。不得用 aka 随意冒充原名。
- 详情 `episodes_count` 是豆瓣收录的集数，不能当“当前可播集数”。生产元数据可独立记录 totalEpisodes，`MediaItem.episodes` 由经过验证的 CMS availability 填充。episodeTitles 仅来自真实有标题的源，不生成虚构标题。
- 排序值实测 `U=近期热度`、`R=首映时间`、`S=高分优先`。`tags=2025` 正确返回 2025 年作品；`tags=2010年代` 正确返回该十年。`year_range=1900,2019` 被上游忽略并返回 2026 作品，不能使用。
- 仅 `tags=综艺` 会出现“绝望写手”等剧情剧集；频道边界必须校验真实类型/详情 is_show 或明确综艺类型，不能把所有返回行直接强制转换为 variety。仅 `selected_categories` 也未改变样本结果，不能信任它能过滤。
- 上游 recommend_categories 可生成真实地区与类型选项；年份标签使用经过实测支持的年份/年代。“更早”若无准确范围实现不要传无效参数假装生效。
- 搜索结果封面可能有时效性签名；主进程图片代理保存原 URL 并按有效期缓存，不修改其签名参数、不暴露 Cookie。

## 实现清单与边界

1. 在主进程 data 目录独立实现 HTTP 层、响应形状验证、归一化和 DoubanDataSource；不复制见界的 Rust/前端适配器。渲染器只依赖 Panda 契约。
2. 明确错误码区分离线、超时、限流、上游拒绝、响应无效、能力不可用；200 HTML、错误 JSON、空 body 均不能缓存成成功。正常空数组是空态。
3. HTTP 并发上限 4、单源节流、相同请求 single-flight、请求 8–10 秒预算、429/5xx/网络瞬态至多 1 次带抖动退避；4xx 输入/形状错误不重试。取消/新搜索代次丢弃旧结果。
4. 成功数据按端点缓存：频道/榜单 10 分钟、联想与搜索 2 分钟、详情 24 小时；按条数和字节限制。收藏历史可从主进程持久化真实元数据离线展示；过期缓存回读必须带可见离线/过期状态，不能掩盖刷新错误。
5. home 按原型栏目结构聚合真实列表和官方榜单；任何主请求失败暴露错误，不能用 mock 或随意移用另一栏目冒充。
6. 详情主请求与附加 credits/photos 独立；附加信息失败保留已获得真实详情并向调用方报告能力错误。缺字段不伪造。
7. 归一化单测覆盖两种 subtitle、无评分/图片、0 集数、错误 JSON、非影视卡、同名搜索身份、无效游标、过滤后分页和服务端忽略筛选。网络层测超时/取消/重试/并发/缓存失效。
8. 真实接口 E2E 将测试与生产路径分离：没有生产 fixture 开关、硬编码片库、虚拟时长或本地假播放地址。

## 关键选择

主进程 TypeScript 实现可与 Electron IPC 契约共享类型，并可测试注入 fetch/图片 URL mapper；Electron 网络请求或 Node fetch 由主进程封装，不能让渲染器直连豆瓣。使用官方无凭据端点降低秘密材料和反代依赖。旧 j/subject_suggest 无结果、签名 Frodo key、HTML 抓取不作为核心链路。热搜的最终来源见下文复审。

## 复审与补充（2026-11-16，实现完成后）

实现见 [src/main/data/](../src/main/data/)；本节只记录编码期间实测到、上文没有的事实。

| 事实 | 证据 | 处理 |
| --- | --- | --- |
| 频道筛选需要远多于 `recommend_categories` 的词 | 逐项用生产数据源读取首页，至少 6 部才保留：共 738 项全部通过（剧集 类型 72 / 地区 46 / 年份 23，电影 102 / 46 / 23，动画 84 / 46 / 23，综艺 62 / 42 / 23，纪录片 77 / 46 / 23），见 [filter-vocabulary.json](evidence/filter-vocabulary.json) | 词表在 [taxonomy.ts](../src/main/data/taxonomy.ts)；`npm run probe:filters` 可重放，单测要求词表与证据逐项一致。取舍见[决策记录](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/.agents/notes/implemented/architecture/2026-11-16-filter-vocabulary.md) |
| 冷门筛选组合是现算的 | 请求要么挂起到算完（实测最长约 14 秒），要么约 1.2 秒返回“部分页”：`total` 正确、条目只有几条，同一请求可稳定重复返回同一部分页 | 列表请求等待 20 秒且超时不重发；条数不足即判为部分页、不缓存、重读一次，再不完整就拆成 10 条、5 条的小页；仍读不全报超时，不把部分页当结果 |
| 合集条目的海报字段不同 | `subject_collection/movie_latest/items` 的条目没有 `pic`，海报在 `cover.url`（对象）；`tv_hot`、`tv_animation` 等仍用 `pic`。漏读时首页“最新电影”整栏没有海报 | 归一化按 `pic.large` → `pic.normal` → `cover_url` → `cover` → `cover.url` 取第一个豆瓣图片地址（[data.test.ts](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/tests/data.test.ts)）；[data.spec.ts](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/e2e/data.spec.ts) 断言首页每一栏的海报都在真实窗口里解码 |
| 详情的 `genres` 最多三项 | 《罗小黑战记》详情 `genres` 为 剧情/喜剧/动作，`card_subtitle` 为“剧情 喜剧 动作 动画 奇幻”；只用前者时，打开详情后该片从动画变成剧集 | 类型取 `genres` 与副标题类型的并集（[data.test.ts](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/tests/data.test.ts)） |
| 详情 `aka` 给出连载区间 | 《凡人修仙传 年番4》`aka` 含“凡人修仙传 第177-228集” | 别名留在主进程元数据里供片源匹配使用，不进入渲染器契约，也不当作原名显示。见[播放审阅](playback-audit.md) |
| 标题末尾可能带零宽字符 | “斗破苍穹剧场版 双帝之战”“凡人修仙传：外海风云”末尾各有一个不可见字符 | 匹配与检索前去除；显示保持上游原文 |
| 影视热搜 | 百度电影榜、电视剧榜 JSON 两次请求均返回带“热搜指数”的条目 | [hot-search.ts](../src/main/data/hot-search.ts) 校验后合并；备选来源的比较见[决策记录](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/.agents/notes/implemented/architecture/2026-11-16-production-completion.md) |

上文“实现清单与边界”第 3 条的请求预算对列表请求有一处修正：列表单次等待 20 秒且不自动重发（重发会让豆瓣重新计算）；其余端点不变。

## 启动路径的修正（2026-11-17）

依据与取舍见[启动决策记录](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/.agents/notes/implemented/architecture/2026-11-17-startup.md)；本节只列与上文不同的事实。

| 事实 | 证据 | 处理 |
| --- | --- | --- |
| 首页要读 10 个接口，原先逐个间隔 180 ms 起跑并等全部返回 | 逐请求计时：最后一个请求在 1.6 s 后才发出，页面在 2.5–3 s 后才有数据 | 安静一段时间后前 4 个请求可同时起跑，之后仍是每 180 ms 一个、同时最多 4 个（第 3 条的“单源节流”改为此）；首页先答首屏，其余栏目按页面顺序补上 |
| 首页成品可以跨运行保存 | 栏目只是条目 id 的列表，条目本身已在主进程元数据库里 | 存为 `cache/home-v1.json`；10 分钟内直接使用，更旧时先显示、同时重读，内容不同才替换；重读失败时保留旧页并给出“正在显示已保存的信息”的提示（第 4 条要求的可见状态） |
| 海报每次运行都重新下载 | 渲染器拿到的是本机代理的随机端口与随机令牌，地址每次运行都变，浏览器缓存不会命中 | 主进程把完整的海报存进 `images/`（按上游地址的 sha256 命名，单张 ≤ 2 MB，共 ≤ 200 MB，按最近显示时间淘汰）；不完整或不是图片的应答不保存 |
| 新建连接偶尔在握手阶段卡死 | 本机代理下 TCP 立即接通、TLS 握手不再有任何字节：40 个新进程里 1 个出现一张海报卡 5.1 s；豆瓣接口同样出现过一轮 7 个请求全部在 10.6 s 失败；解析器请求也会这样 | 连接阶段单独限时 1.5 s，超时换一条新连接重发（请求尚未发出，不会重复计数），第二次给 4 s；卡住的海报地址在 30 秒内排到该主机其他地址之后；两个解析器 1.5 s 内都没答复时各再问一次 |
| 首页下方栏目单次读取失败 | 同上，偶发 | 首次读取时 2 s、6 s 后各重读一次；仍失败的栏目不显示并记诊断，这一份首页不保存，下次启动重新读取 |

## 演职员与影人作品（2026-11-17）

依据与取舍见[决策记录](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/.agents/notes/implemented/architecture/2026-11-17-people.md)；可重放：`node docs/evidence/probe-people.mjs`，结果在 [people-audit.json](evidence/people-audit.json)（45 部作品、3 位影人；文件里是 21:21 那次，21:15 那次的数字在决策记录里）。

| 用途 | 官方端点 | 实测与处理 |
| --- | --- | --- |
| 详情页的主要演职员 | m.douban.com/rexxar/api/v2/{movie,tv}/{id}/credits | `{ items, total }`，每部 4–8 行：导演、最多 6 位演员（按番位）、其他部门负责人；字段 `id`、`name`、`category`、`simple_character`（“饰 汪淼”“总编剧”）、`avatar.normal/large`。45 部全部答复，中位 52 毫秒。同一人可占多行，合并为一项。取代上表的 `celebrities`（每部 4–96 人，且同一请求会答复不同的一批人）。 |
| 照片 | 上一行的 `avatar`、下一行的 `cover` | 真实照片的路径都在 `/view/` 下；没有照片的人给的是通用剪影（`/f/vendors/…/personage-default-medium.png`、`/cuphead/vendors/pics/personage-default-*.png`），不当作照片。347 行里 329 行有照片。 |
| 影人 | .../celebrity/{id} | `title` 为姓名，`cover.normal.url` / `cover.large.url` 为照片；查无此人 404 `traversal_error`。 |
| 影人的全部作品 | .../celebrity/{id}/works?start=&count= | `{ start, count, total, works: [{ roles, work }] }`，`work` 是与列表相同的条目卡；按评分从高到低，未评分、未上映在最后；`count` 上限 50。会答复残缺页，重读即全（23 个区间里 6 个）；每页 30、10、5 读出的前 60 部顺序相同。书籍等非影视条目不进入列表。 |
