# 怒羽攻城 / Flock Fortress

轻量、无第三方运行时依赖的网页版弹弓攻防游戏。支持 4 个单人关卡，以及实时双人“小鸟进攻 / 小猪筑城”五局三胜对战。

## 玩法

- 单人：向后拖动弹弓上的小鸟，松开发射；飞行中点击画布或按空格使用一次能力。
- 双人鸟方：在每回合准备阶段购买 1–6 只不同价位的小鸟，准备后依次发射。
- 双人猪方：购买梁、柱、玻璃和 1–3 只猪，在虚线区域点击放置；拖拽调整，右键删除退款。
- 筑城确认时，服务端检查数量、越界、重叠与结构支撑。猪全灭则鸟方赢；小鸟耗尽则猪方赢；先胜 3 回合赢得比赛。
- 经济：鸟/猪分别以 500/700 开局；胜者 +150，败者 +240 与最高 +180 连败补偿；摧毁建筑/猪有小额奖励；资金封顶 1200。

## 本地运行

只需要 Python 3.10+：

```bash
python3 server/app.py --host 127.0.0.1 --port 18080
```

打开 `http://127.0.0.1:18080`，健康检查位于 `/healthz`。

## 生产部署

项目部署路径为 `/home/hs/workspace/flock-fortress`，普通文件操作使用 `hs`。仅安装 systemd 单元时使用 root：

```bash
sudo ./deploy/install-service.sh
./manage.sh start
./manage.sh enable
./manage.sh status
./manage.sh health
```

`enable`/`disable` 只改变开机自启动状态，不会隐式启动或停止服务。服务为单 Python 进程，设置 96MiB 软上限、128MiB 硬上限、80% CPU、32 任务和 1024 文件描述符上限。应用层另限制 80 个连接、32 个房间、16KiB 消息、每连接 10 秒 100 条消息与 70 秒空闲超时。

日志进入 systemd journal，不产生项目日志文件；查看方式为 `./manage.sh logs`。日志保留遵循服务器现有 journald 策略。

## 参考与许可

玩法结构、示例梁柱布局，以及 `background.png`、`red-bird.png`、`sling.png`、`wood-source.png` 参考/取自 [estevaofon/angry-birds-python](https://github.com/estevaofon/angry-birds-python)（MIT，版权归 Estevao）。原许可证保存在 `REFERENCE_LICENSE`。本项目未将任何密码、Token 或私钥写入代码。
