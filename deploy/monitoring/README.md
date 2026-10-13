# 图片任务监控（O01）

本目录提供配置与规则，不会自动启用生产监控。应用必须在启动前配置 `METRICS_SECRET`，采集端以同一个 secret 的只读文件发送 Bearer token。不要把 token 提交到 Git 或写进查询参数。`/metrics` 无密钥或认证错误时仍返回 401。

## 指标语义

- `http_requests_total` / `http_request_duration_seconds` 区分图片生成、任务轮询、图片结果、模板、批量及管理用量路由。路径中的 ID、令牌与查询参数不会成为标签；未知后缀仍落到 `/api/#path`。
- `image_worker_running`、`image_worker_ticks_in_flight`、`image_worker_ticks_total`、`image_worker_tick_duration_seconds`、`image_worker_last_tick_timestamp_seconds` 是**本进程循环指标**。空闲、并发已满或无匹配任务的 tick 也可以成功。心跳不证明 provider 正常、不表示任务完成；需要结合持久化队列年龄。
- `image_queue_jobs`、`image_queue_oldest_entered_timestamp_seconds`、`image_queue_expired_leases` 每 60 秒只读采样一次。状态仅包括 waiting/submitting/submitted/polling/status_unknown。终态成功、失败和取消不累计。三个标签有固定集合：worker（apimart_img2/image_egress/legacy）、status、eligibility（eligible/ineligible）；不包含用户、任务、模型名称或 prompt。
- eligibility 仅指已存储的 workerEligible。它不是“此刻可 claim”的承诺，仍需匹配 rolloutMode、nextPollAt、容量等约束。legacy 是不属于 V2 APIMart 或 V3 image-egress 的记录；不会触发示例任务积压告警。历史现代 unknown 仍会告警，应人工确认，不能自动清理或 resubmit。
- 最老时间采用 queueEnteredAt，旧记录缺失则使用 createdAt；未知时间为 0。过期 lease 指仍有 workerOwner 且 workerLeaseUntil 是已到期日期；不统计 provider 并发 permit 或 slot。
- snapshot_success 表示最近一次采样是否成功；snapshot_last_success_timestamp_seconds 表示数据新鲜度。失败保留上一次数值，不伪造空队列。启动尚未成功采样时新鲜度为 0。
- 每个进程各自采样同一数据库。多副本部署应按 worker/status/eligibility 使用 max，**不要 sum 队列 gauge**；worker tick 则是各实例自己的值。示例告警保留 instance 标签，接收端按 alertname/worker/status 分组。

## 开销与隔离

采样只在 METRICS_SECRET 配置且服务连接数据库后启动；没有密钥时不查询。采样不重叠。聚合仅匹配有索引的 status 字段，不加载任务明细；Mongo 执行上限 2 秒、驱动操作上限 2.5 秒，禁用磁盘聚合。数据量增长可能导致超时：此时报告采样异常，勿无条件增大超时。HTTP scrape 只读内存指标，不能触发数据库查询。停机先停止采样，再等待已在执行的读取完成。

## 接入步骤

1. 在密钥管理中准备随机 token，分别挂载给应用和采集端；发布应用后检查匿名访问 401、授权访问 200。
2. 将 `prometheus.example.yml` 的采集配置合入应用所属采集器。示例使用 HTTPS 公共地址；如果改用集群内 HTTP，仅限受控网络。不要直接覆盖平台管理的 VictoriaMetrics 配置。
3. Prometheus 加载规则；如使用 VictoriaMetrics，则采集配置和 **vmalert** 规则评估分别接入。单独 vmsingle 存储指标并不代表已评估告警。
4. 配置 Alertmanager/已有接收端后进行一次明确标识的测试通知，验证触发、接收与恢复。当前模板不含接收人，不能据此宣称有人收到告警。
5. 留存实际 targets 的 up=1、最新采样时间、规则状态、通知和恢复证据后，才能把 O01 标为已关闭。

阈值是保守初始值：采样/心跳 3 分钟无更新并持续 2 分钟；waiting 超 10 分钟并持续 5 分钟；活动任务超 30 分钟；unknown/过期 lease 持续 5 分钟。按真实业务 SLA 调整。worker 正常关闭/feature off 不产生心跳告警；若仍有已入队任务，积压告警保留，提醒排查 rollout 设置。任何告警都**不自动重试生成**。

## 本地验证

使用官方 promtool（本次验证版本 3.14.0）：

```sh
promtool check config --syntax-only deploy/monitoring/prometheus.example.yml
promtool check rules deploy/monitoring/image-reliability.rules.yml
promtool test rules deploy/monitoring/image-reliability.test.yml
```

测试只使用合成时序，无真实 provider 调用、生产 mutation 或通知发送。
官方参考：[采集配置](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)、[规则测试](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/)。
