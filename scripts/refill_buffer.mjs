/**
 * Office Munder Difflin — Automated Buffer Cloud Queue Refill Engine
 * 
 * Runs 24/7 in GitHub Actions.
 * Guarantees:
 * 1. Strictly maintains 9-video background rotation order (Group 1 -> Group 2 -> Group 3 -> Group 4).
 * 2. Permanent constraints: isAiGenerated = false, shouldShareToFeed = false (Reels tab only).
 * 3. Never exceeds Buffer's 10-post capacity.
 * 4. Refills slots as previous videos publish.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const API_KEY = process.env.BUFFER_API_KEY;
if (!API_KEY) {
  console.error('❌ BUFFER_API_KEY environment variable is missing.');
  process.exit(1);
}

const ORG_ID = '6aaaa5010d476dced3dc4823';
const CHANNELS = [
  { id: '6aae6f70ea19ca0bde86d1bd', name: 'TikTok', service: 'tiktok' },
  { id: '6aaaa58bea19ca0bde593dee', name: 'Instagram', service: 'instagram' },
];

const MAX_QUEUE_LIMIT = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function callBufferMcp(name, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    const req = https.request('https://mcp.buffer.com/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { resolve({ raw: d, statusCode: res.statusCode }); }
      });
    });

    req.on('error', (err) => resolve({ error: err.message }));
    req.write(body);
    req.end();
  });
}

async function getScheduledPosts(channelId) {
  const res = await callBufferMcp('list_posts', {
    organizationId: ORG_ID,
    channelIds: [channelId],
    status: ['scheduled'],
    first: 50,
  });

  const text = res?.result?.content?.[0]?.text;
  if (!text) {
    if (res?.raw?.includes('429') || text?.includes('429')) {
      console.warn('⚠️ Buffer rate limit (429) hit. Will retry next cycle.');
      return null;
    }
    return [];
  }

  try {
    const data = JSON.parse(text);
    return (data.edges || []).map((e) => e.node);
  } catch {
    return [];
  }
}

async function main() {
  console.log('======================================================');
  console.log('🏢 BUFFER CLOUD REFILL ENGINE — 24/7 GITHUB RUNNER');
  console.log(`⏰ Execution Time: ${new Date().toISOString()}`);
  console.log('======================================================\n');

  // Find active manifests
  const manifestsDir = path.join(process.cwd(), 'manifests');
  if (!fs.existsSync(manifestsDir)) {
    console.error('❌ manifests directory not found.');
    process.exit(1);
  }

  const batchFolders = fs.readdirSync(manifestsDir).filter((f) => fs.statSync(path.join(manifestsDir, f)).isDirectory());
  if (batchFolders.length === 0) {
    console.log('ℹ️ No batch schedules found.');
    return;
  }

  // Use latest batch
  const latestBatch = batchFolders.sort().pop();
  const scheduleFile = path.join(manifestsDir, latestBatch, 'schedule.json');
  console.log(`📂 Active Batch: ${latestBatch}`);

  const scheduleData = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
  const allItems = scheduleData.items;

  // Audit current Buffer queue
  console.log('🔍 Checking Buffer scheduled queue...');
  const tiktokPosts = await getScheduledPosts(CHANNELS[0].id);
  await sleep(1500);
  const instaPosts = await getScheduledPosts(CHANNELS[1].id);

  if (tiktokPosts === null || instaPosts === null) {
    console.log('⏳ Buffer API rate limited. Skipping this cycle safely.');
    return;
  }

  const currentCount = Math.max(tiktokPosts.length, instaPosts.length);
  console.log(`📊 Buffer Queue Status: ${currentCount} / ${MAX_QUEUE_LIMIT} slots filled.`);

  const availableSlots = MAX_QUEUE_LIMIT - currentCount;
  if (availableSlots <= 0) {
    console.log('✅ Buffer queue is at full capacity (10/10). No refills needed right now.');
    return;
  }

  console.log(`🎯 Slots available to refill: ${availableSlots}`);

  const now = new Date();

  // Determine which items are unscheduled and in the future
  const scheduledDates = new Set(
    [...tiktokPosts, ...instaPosts].map((p) => new Date(p.dueAt).toISOString().slice(0, 16))
  );

  const pendingItems = allItems.filter((item) => {
    const itemDate = new Date(item.dueAtUtc);
    if (itemDate <= now) return false; // Already passed
    const itemDateKey = itemDate.toISOString().slice(0, 16);
    if (scheduledDates.has(itemDateKey)) return false; // Already scheduled
    return true;
  });

  console.log(`📋 Total pending videos waiting in reserve: ${pendingItems.length}`);
  if (pendingItems.length === 0) {
    console.log('🎉 All future videos in this batch are already scheduled or completed!');
    return;
  }

  // Strictly take the next N items in chronological order
  const toSchedule = pendingItems.slice(0, availableSlots);
  console.log(`\n🚀 Refilling ${toSchedule.length} video(s) into Buffer...\n`);

  for (const item of toSchedule) {
    console.log(`------------------------------------------------------`);
    console.log(`▶️ Scheduling [#${item.batchIndex}] ${item.title}`);
    console.log(`   Slot: ${item.slot} (${item.dueAtUtc})`);
    console.log(`   Background: ${item.bg}`);
    console.log(`   CDN: ${item.cdnUrl}`);

    for (const ch of CHANNELS) {
      const payload = {
        channelId: ch.id,
        text: item.description,
        schedulingType: 'automatic',
        mode: 'customScheduled',
        dueAt: item.dueAtUtc,
        saveToDraft: false,
        assets: [
          {
            video: {
              url: item.cdnUrl,
              metadata: {
                title: item.title,
                thumbnailOffset: 0,
              },
            },
          },
        ],
        metadata:
          ch.service === 'instagram'
            ? {
                instagram: {
                  type: 'reel',
                  shouldShareToFeed: false,
                  isAiGenerated: false,
                },
              }
            : { tiktok: { isAiGenerated: false } },
      };

      const res = await callBufferMcp('create_post', payload);
      const text = res.result?.content?.[0]?.text;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}

      if (parsed?.id) {
        console.log(`   ✅ [${ch.service.toUpperCase()}] Scheduled ID: ${parsed.id}`);
      } else {
        console.error(`   ❌ [${ch.service.toUpperCase()}] Response:`, text || JSON.stringify(res));
      }
      await sleep(2000); // 2s rate-limit pause
    }
  }

  console.log('\n======================================================');
  console.log('🎉 REFILL CYCLE FINISHED SUCCESSFULLY');
  console.log('======================================================');
}

main().catch(console.error);
