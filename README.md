<div align="center">

# Discord Quest Auto

Làm quest Discord ngay trên terminal: **video · play · activity · achievement**.
Không trình duyệt, không database, không proxy. Một token, một fingerprint, một hàng đợi.

[![CI](https://github.com/KashikoKanda/discord-quest-auto/actions/workflows/ci.yml/badge.svg)](https://github.com/KashikoKanda/discord-quest-auto/actions/workflows/ci.yml)
[![Quests](https://github.com/KashikoKanda/discord-quest-auto/actions/workflows/quests.yml/badge.svg)](https://github.com/KashikoKanda/discord-quest-auto/actions/workflows/quests.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-informational)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

<a id="dieu-huong"></a>

## Điều hướng nhanh

| Bắt đầu                                | Dùng hằng ngày                                            | Hiểu bên trong                                          |
| :------------------------------------- | :-------------------------------------------------------- | :------------------------------------------------------ |
| [Chạy trên GitHub](#chay-tren-github)  | [Lệnh](#lenh) · [Cờ](#co)                                 | [Cấu trúc dự án](#cau-truc)                             |
| [Chạy trên máy](#chay-tren-may)        | [Cấu hình](#cau-hinh) · [Lỗi thường gặp](#loi-thuong-gap) | [Một lượt chạy](#luot-chay) · [Loại quest](#loai-quest) |
| [Cài trong 30 giây](#chay-tren-github) | [Nhận thưởng](#lenh)                                      | [Ba nguyên tắc an toàn](#ba-nguyen-tac)                 |

---

<a id="chay-tren-github"></a>

## Chạy trên GitHub

Không cần cài gì, không cần tạo secret.

1. **Fork** repo này (hoặc dùng trực tiếp).
2. Mở **Actions → Quests → Run workflow**.
3. Dán token tài khoản vào ô `token` rồi bấm **Run workflow**.

Workflow sẽ checkout code, cài dependency, chạy `bot.ts run`, giữ `.quest-store.json`
trong cache để tài khoản luôn mang một danh tính thiết bị duy nhất, và tải log lên
làm artifact. Token được che (`***`) trước khi bot khởi động và không ghi xuống đĩa.

Các ô khi bấm Run:

| Ô nhập     | Chọn gì                                                     | Tương đương    |
| :--------- | :---------------------------------------------------------- | :------------- |
| `multi`    | **bật** làm mọi quest còn thiếu, **tắt** chỉ làm `quest_id` | `--quest=<id>` |
| `quest_id` | id quest, bắt buộc khi công tắc `multi` tắt                 | `--quest=<id>` |
| `gap`      | số giây nghỉ tối thiểu giữa hai quest, mặc định 10          | `--gap=<giây>` |

Workflow **chỉ làm quest, không nhận thưởng**. Quest xong là dừng; muốn lấy thưởng
thì chạy `npm run claim` trên máy.

Quest luôn chạy **lần lượt**, mỗi quest cách nhau ít nhất `gap` giây (cộng thêm 0–5 giây
ngẫu nhiên), và từng request vẫn qua hàng đợi của engine nên không spam Discord.

Muốn khỏi dán token mỗi lần: tạo secret `DISCORD_TOKEN` trong **Settings → Secrets and
variables → Actions**, rồi sửa `required: true` thành `false` cho ô `token`. Khi ô trống,
workflow tự dùng secret.

<a id="chay-tren-may"></a>

## Chạy trên máy

```bash
npm install
cp .env.example .env      # dán token vào TOKEN=
npm start                 # làm hết quest rồi thoát
```

Cần Node 20 trở lên.

<a id="lenh"></a>

## Lệnh

| Lệnh                              | Việc nó làm                               |
| :-------------------------------- | :---------------------------------------- |
| `npm start`                       | Làm mọi quest đang có (không nhận thưởng) |
| `npm run list`                    | Xem danh sách quest kèm tiến trình        |
| `npm run claim`                   | Chỉ nhận thưởng cho quest đã xong         |
| `npm run auto`                    | Chạy nền, 5 phút quét quest mới một lần   |
| `npm run status`                  | Tiến trình nền đang làm gì                |
| `tsx --env-file=.env bot.ts stop` | Dừng `run` hoặc `auto` đang chạy          |

<a id="co"></a>

## Cờ

Đặt sau lệnh:

```bash
tsx --env-file=.env bot.ts run --quest=<id>    # một quest duy nhất
tsx --env-file=.env bot.ts run --multi         # chạy song song thay vì lần lượt
tsx --env-file=.env bot.ts run --log=run.log   # đổi file log (mặc định logs/quest-<ngày>.log)
tsx --env-file=.env bot.ts run --gap=20        # nghỉ tối thiểu 20s giữa hai quest
tsx --env-file=.env bot.ts list --all          # gồm cả quest đã nhận thưởng
tsx --env-file=.env bot.ts list --json         # dạng JSON
tsx --env-file=.env bot.ts auto --force        # bỏ qua kiểm tra server bắt buộc
```

Chạy dài hạn trong tmux:

```bash
tmux new -s quest 'npm run auto'
# thoát ra: Ctrl-B rồi D   ·   quay lại: tmux attach -t quest
```

<a id="cau-hinh"></a>

## Cấu hình

| Biến          | Mặc định            | Ý nghĩa                                                                  |
| :------------ | :------------------ | :----------------------------------------------------------------------- |
| `TOKEN`       | bắt buộc            | Token tài khoản. Trên Actions lấy từ ô nhập, hoặc secret `DISCORD_TOKEN` |
| `QUEST_STORE` | `.quest-store.json` | Nơi lưu fingerprint của từng token                                       |
| `QUEST_STATE` | `.quest-state.json` | File pid cho `status` và `stop`                                          |

Hai file đầu được tạo ở lần chạy đầu và đã nằm trong `.gitignore`.

<a id="cau-truc"></a>

## Cấu trúc dự án

```
bot.ts                  điều phối lệnh, cờ, đọc log
src/
  api/
    client.ts           REST: header fingerprint, build number, list/enroll/claim
    gateway.ts          socket gateway: identify, presence, heartbeat
  core/
    state.ts            trạng thái mỗi token: hàng đợi, log, tiến trình, abort
    queue.ts            hàng đợi API riêng từng token: giãn cách, retry 429, backoff 5xx
    store.ts            lưu fingerprint
    config.ts           .env, token id, file pid
    constants.ts        endpoint, server bắt buộc, thời gian
    interface.ts        type dùng chung
    logger.ts           in ra terminal và file
  quests/
    quest.ts            helper đọc shape quest + wrapper Quest
    video.ts            WATCH_VIDEO, WATCH_VIDEO_ON_MOBILE
    play.ts             PLAY_ON_DESKTOP và bản console
    activity.ts         PLAY_ACTIVITY
    achievement.ts      ACHIEVEMENT_IN_ACTIVITY
    index.ts            dispatcher: bỏ qua, enroll, chuyển đúng handler
  worker.ts             điều phối lượt chạy: batch, auto loop, API công khai
```

Thêm một loại quest = thêm một file trong `src/quests/` và một `case` trong
`src/quests/index.ts`.

<a id="luot-chay"></a>

## Một lượt chạy

```
bot.ts              worker.ts            api/client.ts             Discord
──────              ─────────            ─────────────             ───────
đọc .env     ──▶    mở gateway      ──▶  POST /quests/@me/enroll
                    GET /quests/@me
                    quests/index.ts   ──▶  video-progress · heartbeat · discordsays
                    poll user_status  (dừng ở đây)

bot.ts claim        claimCompleted    ──▶  POST /quests/@me/{id}/claim
```

<a id="loai-quest"></a>

## Loại quest

| Loại                                                     | Module           | Cách hoàn thành                                                                             |
| :------------------------------------------------------- | :--------------- | :------------------------------------------------------------------------------------------ |
| `WATCH_VIDEO`, `WATCH_VIDEO_ON_MOBILE`                   | `video.ts`       | Gửi `video-progress` với timestamp tăng dần tới khi đủ số giây                              |
| `PLAY_ON_DESKTOP`, `PLAY_ON_XBOX`, `PLAY_ON_PLAYSTATION` | `play.ts`        | Presence + heartbeat kèm application id tới khi Discord báo xong                            |
| `PLAY_ACTIVITY`                                          | `activity.ts`    | Heartbeat của activity tới khi đủ thời lượng                                                |
| `ACHIEVEMENT_IN_ACTIVITY`                                | `achievement.ts` | Xin ticket, mở activity instance, heartbeat trên `*.discordsays.com` tới khi achievement nổ |
| `STREAM_ON_DESKTOP`                                      | bỏ qua           | Discord chỉ tính khi stream từ client desktop thật                                          |

Thưởng yêu cầu tài khoản ở server bắt buộc. Không ở đó thì quest vẫn chạy nhưng không
nhận thưởng; link mời in ra lúc khởi động.

<a id="ba-nguyen-tac"></a>

## Ba nguyên tắc an toàn

- **Một hàng đợi mỗi token.** Request cách nhau 1500–3000 ms, 429 tôn trọng
  `retry-after`, 5xx backoff lũy thừa. Không bao giờ có hai request cùng lúc.
- **Tiến trình theo thời gian thực.** Quest video gửi 1 giây xem cho mỗi 1 giây thật;
  quest play/activity heartbeat mỗi 30 giây như client thật.
- **Một fingerprint cố định.** User agent, locale, timezone, launch id, session id
  sinh một lần cho mỗi token và dùng lại ở mọi lần chạy sau.

Mặc định quest chạy lần lượt. `--multi` chạy song song nhưng vẫn qua cùng một hàng đợi.

<a id="phat-trien"></a>

## Phát triển

```bash
npm run typecheck     # tsc --noEmit
npm run format        # prettier --write
npm run ci            # typecheck + kiểm tra format
```

CI chạy đúng hai bước này ở mỗi push và pull request.

<a id="loi-thuong-gap"></a>

## Lỗi thường gặp

| Hiện tượng                                             | Nguyên nhân                                                    |
| :----------------------------------------------------- | :------------------------------------------------------------- |
| `Token không hợp lệ hoặc đã hết hạn`                   | Token bị xoay hoặc dán sai, lấy token mới                      |
| `Thiếu token`                                          | `TOKEN=` đang trống, hoặc chưa nhập ô `token` / chưa có secret |
| Quest xong mà không thấy thưởng                        | Tài khoản không ở server bắt buộc                              |
| Một quest bị bỏ qua với "không hoạt động trên Node.js" | Đó là `STREAM_ON_DESKTOP`                                      |
| Quest video đứng giữa chừng                            | Gateway rớt phiên, chạy lại là được                            |

<a id="mien-tru"></a>

## Miễn trừ

Dùng token của chính bạn và mô phỏng luồng client chính chủ. Tự động hoá tài khoản có
thể vi phạm Terms of Service của Discord. Tự chịu rủi ro, chỉ dùng với tài khoản của bạn.

<a id="giay-phep"></a>

## Giấy phép

MIT
