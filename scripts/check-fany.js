// FANYチケットの検索結果を芸人ごとにチェックし、
// 新しい公演が見つかったらLINE通知＋Googleカレンダーに登録する。
//
// 使い方: node scripts/check-fany.js
// 必要な環境変数:
//   LINE_CHANNEL_ACCESS_TOKEN  ... LINE Messaging APIのチャネルアクセストークン
//   LINE_TO_ID                 ... 通知を送るユーザーID or グループID
//   GOOGLE_SERVICE_ACCOUNT_JSON ... サービスアカウントのJSON鍵（文字列そのまま）
//   GOOGLE_CALENDAR_ID          ... 登録先カレンダーID（省略時は 'primary'）

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const COMEDIANS_PATH = path.join(__dirname, '../config/comedians.json');
const STATE_PATH = path.join(__dirname, '../data/fany-state.json');

const SEARCH_BASE = 'https://ticket.fany.lol/search/event';

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    return fallback;
  }
}

function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function makeId(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// 見出しテキストから日付・開演時刻・タイトルをざっくり抜き出す。
function parseHeading(raw) {
  const text = raw.replace(/\s+/g, ' ').trim();
  const dateMatch = text.match(/(\d{4})\/(\d{2})\/(\d{2})/);
  const startTimeMatch = text.match(/開演\s*(\d{2}):(\d{2})/);
  const venueMatch = text.match(/（([^）]+)）\s*$/);

  let title = text;
  title = title.replace(/^\d{4}\/\d{2}\/\d{2}\([^)]+\)(\s*[～〜]\s*\d{4}\/\d{2}\/\d{2}\([^)]+\))?\s*/, '');
  title = title.replace(/開場\s*\d{2}:\d{2}\s*/, '');
  title = title.replace(/開演\s*\d{2}:\d{2}\s*/, '');
  if (venueMatch) {
    title = title.replace(/（[^）]+）\s*$/, '');
  }
  title = title.trim();

  return {
    dateStr: dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null,
    startTime: startTimeMatch ? `${startTimeMatch[1]}:${startTimeMatch[2]}` : null,
    venue: venueMatch ? venueMatch[1] : null,
    title: title || text,
  };
}

// ブラウザで検索ページを開き、「もっと見る」ボタンが無くなるまでクリックして
// 全件を読み込んだ状態のHTMLを取得する。
async function fetchFullHtml(browser, name) {
  const url = `${SEARCH_BASE}?keywords=${encodeURIComponent(name)}&search_type=search_string`;
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (compatible; fany-watch/1.0)');

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    for (let i = 0; i < 30; i++) {
      const clicked = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('button, a, div, span'));
        const moreBtn = candidates.find(
          (el) => el.textContent && el.textContent.trim() === 'もっと見る'
        );
        if (moreBtn) {
          moreBtn.scrollIntoView();
          moreBtn.click();
          return true;
        }
        return false;
      });
      if (!clicked) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

async function fetchEventsFor(browser, name) {
  const html = await fetchFullHtml(browser, name);
  const $ = cheerio.load(html);

  const events = [];
  const seen = new Set();

  $('a[href*="/reception/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) return;

    let heading = '';
    let node = $el.closest('article, section, li, div, tr');
    for (let i = 0; i < 4 && node && node.length; i++) {
      const h = node.find('h1,h2,h3,h4').first();
      if (h.length) {
        heading = h.text().trim();
        break;
      }
      const prevH = node.prevAll('h1,h2,h3,h4').first();
      if (prevH.length) {
        heading = prevH.text().trim();
        break;
      }
      node = node.parent();
    }

    if (!heading) return;

    const parsed = parseHeading(heading);
    const id = makeId(`${name}::${heading}`);
    if (seen.has(id)) return;
    seen.add(id);

    events.push({
      id,
      comedian: name,
      rawHeading: heading,
      title: parsed.title,
      dateStr: parsed.dateStr,
      startTime: parsed.startTime,
      venue: parsed.venue,
      url: href.startsWith('http') ? href : `https://ticket.fany.lol${href}`,
    });
  });

  return events;
}

async function notifyLine(events) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = process.env.LINE_TO_ID;
  if (!token || !to) {
    console.log('[LINE] トークン未設定のためスキップ');
    return;
  }

  const lines = events.map((e) => {
    const when = [e.dateStr, e.startTime].filter(Boolean).join(' ');
    return `【${e.comedian}】${e.title}\n${when}${e.venue ? ' @' + e.venue : ''}\n${e.url}`;
  });

  const message = `FANYチケットに新しい公演が追加されました\n\n${lines.join('\n\n')}`;

  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    {
      to,
      messages: [{ type: 'text', text: message.slice(0, 4900) }],
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  console.log(`[LINE] ${events.length}件通知しました`);
}

async function addToGoogleCalendar(events) {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) {
    console.log('[Calendar] サービスアカウント未設定のためスキップ');
    return;
  }
  const { google } = require('googleapis');
  const credentials = JSON.parse(saJson);
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  });
  const calendar = google.calendar({ version: 'v3', auth });

  for (const e of events) {
    if (!e.dateStr) {
      console.log(`[Calendar] 日付が読み取れなかったためスキップ: ${e.title}`);
      continue;
    }

    let start, end;
    if (e.startTime) {
      const startDateTime = `${e.dateStr}T${e.startTime}:00+09:00`;
      const [h, m] = e.startTime.split(':').map(Number);
      const endH = (h + 2) % 24;
      const endDateTime = `${e.dateStr}T${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`;
      start = { dateTime: startDateTime, timeZone: 'Asia/Tokyo' };
      end = { dateTime: endDateTime, timeZone: 'Asia/Tokyo' };
    } else {
      start = { date: e.dateStr };
      end = { date: e.dateStr };
    }

    try {
      await calendar.events.insert({
        calendarId,
        requestBody: {
          summary: `【FANY】${e.comedian} ${e.title}`,
          location: e.venue || '',
          description: e.url,
          start,
          end,
        },
      });
      console.log(`[Calendar] 登録: ${e.title}`);
    } catch (err) {
      console.error(`[Calendar] 登録失敗: ${e.title}`, err.message);
    }
  }
}

async function main() {
  const comedians = loadJson(COMEDIANS_PATH, []);
  const state = loadJson(STATE_PATH, {});

  const newEvents = [];

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    for (const name of comedians) {
      console.log(`検索中: ${name}`);
      let events = [];
      try {
        events = await fetchEventsFor(browser, name);
      } catch (err) {
        console.error(`取得失敗 (${name}):`, err.message);
        continue;
      }

      console.log(`  ${events.length}件取得`);

      if (!state[name]) state[name] = [];
      const known = new Set(state[name]);

      for (const e of events) {
        if (!known.has(e.id)) {
          newEvents.push(e);
          known.add(e.id);
        }
      }
      state[name] = Array.from(known);
    }
  } finally {
    await browser.close();
  }

  if (newEvents.length === 0) {
    console.log('新しい公演はありませんでした');
  } else {
    console.log(`新しい公演: ${newEvents.length}件`);
    await notifyLine(newEvents);
    await addToGoogleCalendar(newEvents);
  }

  saveJson(STATE_PATH, state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
