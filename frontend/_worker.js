// --- TVBox Aggregator _worker.js - Final Version 4.2 (Module Worker Fix) ---
// v4.1 reinstated the critical CORS headers that were mistakenly removed
// during the simplification process. This is the direct fix for the
// "net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin" error.
// v4.2 fixes Error 1019: _worker.js advanced mode requires Module Worker
// syntax (export default { fetch }), NOT the functions/ file-routing
// onRequest(context) export. The old onRequest-only export left the
// production Worker without a valid entry point, so every request failed
// at the runtime layer. Business logic below is unchanged.
// v4.3 adds fixed live sources: the merge only collects on-demand sites,
// so lives is filled with two public playlists (fanmingming CCTV+satellite,
// IPv6 streams; iptv-org China list as an IPv4 fallback).
// v4.4 swaps the live source to fanmingming itv.m3u (IPv4, 189 channels):
// v4.3's ipv6.m3u black-screened in the 小安 test — all streams IPv6,
// unplayable without IPv6. itv.m3u is IPv4 (China Mobile cmvideo).

/**
 * Creates a standard JSON response object with essential CORS headers.
 * @param {any} data - The data to be stringified.
 * @param {number} status - The HTTP status code.
 * @returns {Response}
 */
function jsonResponse(data, status = 200) {
    const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*', // Allow any origin
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // Allow common methods
        'Access-Control-Allow-Headers': 'Content-Type, Authorization', // Allow common headers
    };
    return new Response(JSON.stringify(data, null, 2), { status, headers });
}

/**
 * The core aggregation logic. This function runs in the background.
 * @param {string} taskId - The unique ID for this task.
 * @param {object} env - The environment object containing secrets and bindings.
 */
async function runAggregation(taskId, env) {
    const logs = [];
    const log = (message) => logs.push(`[${new Date().toISOString()}] ${message}`);

    let taskState = { status: 'running', logs: '' };
    const updateTaskState = async () => {
        taskState.logs = logs.join('\n');
        // Persist the task state to KV so it can be polled.
        if (env['TVBOX_KV2']) {
            await env['TVBOX_KV2'].put(taskId, JSON.stringify(taskState));
        }
    };

    try {
        log('任务开始: 聚合TVBox源');
        await updateTaskState();

        // 1. Search GitHub.
        log('步骤 1/3: 正在从 GitHub 搜索...');
        const ghToken = env.GH_TOKEN;
        if (!ghToken) throw new Error("配置错误: 未找到 GH_TOKEN 环境变量。");

        const query = 'q=sites+spider+extension:json+tvbox';
        const searchUrl = `https://api.github.com/search/code?${query}`;
        const searchResponse = await fetch(searchUrl, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `token ${ghToken}`,
                'User-Agent': 'TVBox-Aggregator-Cloudflare'
            }
        });
        if (!searchResponse.ok) throw new Error(`GitHub API 搜索失败: ${searchResponse.status}`);
        const searchResult = await searchResponse.json();
        const sourceUrls = searchResult.items.map(item => item.html_url.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/'));

        if (sourceUrls.length === 0) {
            log("警告: 未找到任何源文件。");
            taskState.status = 'completed';
            await updateTaskState();
            return;
        }
        log(`搜索完成，发现 ${sourceUrls.length} 个潜在源。`);
        await updateTaskState();

        // 2. Download and merge.
        log('步骤 2/3: 正在下载并合并...');
        const downloadPromises = sourceUrls.map(url => fetch(url).then(res => res.json()).catch(() => null));
        const downloadResults = await Promise.all(downloadPromises);

        const aggregatedJson = { "sites": [], "lives": [], "rules": [] };
        const siteKeys = new Set();
        for (const sourceJson of downloadResults) {
            if (sourceJson && Array.isArray(sourceJson.sites)) {
                sourceJson.sites.forEach(site => {
                    if (site && site.key && !siteKeys.has(site.key)) {
                        aggregatedJson.sites.push(site);
                        siteKeys.add(site.key);
                    }
                });
            }
        }
        log(`合并完成。聚合站点数: ${aggregatedJson.sites.length}`);
        await updateTaskState();

        // 固定直播源（v4.4）：聚合只收点播站，源文件里的 lives 不合并，
        // 所以直播须单独补。fanmingming itv.m3u 为央视+卫视（IPv4 流，
        // 189 台；v4.3 的 ipv6.m3u 在小安实测黑屏——流全是 IPv6，设备无
        // IPv6 就播不出，已弃）；iptv-org 中国列表为第二组（未逐条验活）。
        aggregatedJson.lives = [
            { "name": "央视卫视", "type": 0, "url": "https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/itv.m3u" },
            { "name": "华语综合", "type": 0, "url": "https://iptv-org.github.io/iptv/countries/cn.m3u" }
        ];
        log(`直播源已补 2 组。`);

        // 3. Store the final result in KV.
        log('步骤 3/3: 正在将最终结果写入KV...');
        if (!env['TVBOX_KV2']) throw new Error("配置错误: 未绑定 TVBOX_KV2 命名空间。");

        await env['TVBOX_KV2'].put('latest_aggregated_result', JSON.stringify(aggregatedJson, null, 2));
        log('写入成功！任务完成！');

        taskState.status = 'completed';
        await updateTaskState();

    } catch (error) {
        log(`任务失败: ${error.message}`);
        taskState.status = 'failed';
        taskState.error = error.message;
        await updateTaskState();
    }
}

/**
 * Main entry point for all requests (Module Worker syntax, required by
 * Pages _worker.js advanced mode). Static assets are served via
 * env.ASSETS; there is no `next()` in this mode.
 */
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Handle CORS preflight requests (OPTIONS method)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                }
            });
        }

        // --- API: Start Task ---
        if (url.pathname === '/api/start-task' && request.method === 'POST') {
            const taskId = `task-${Date.now()}`;
            ctx.waitUntil(runAggregation(taskId, env));
            return jsonResponse({
                message: '任务已启动，请稍后查询状态。',
                taskId: taskId
            });
        }

        // --- API: Get Task Status ---
        if (url.pathname === '/api/task-status') {
            const taskId = url.searchParams.get('taskId');
            if (!taskId) return jsonResponse({ error: '缺少 taskId' }, 400);

            try {
                const taskStateJson = await env['TVBOX_KV2'].get(taskId);
                if (!taskStateJson) return jsonResponse({ status: 'pending', logs: '正在初始化任务...' });

                // Use jsonResponse to ensure CORS headers are included
                return jsonResponse(JSON.parse(taskStateJson));
            } catch (e) {
                return jsonResponse({ handler: 'task-status', error: String((e && e.message) || e), stack: String((e && e.stack) || ''), envKeys: Object.keys(env), kvType: typeof env['TVBOX_KV2'] }, 500);
            }
        }

        // --- Dynamic Route: Get Subscription File ---
        if (url.pathname === '/subscribe.json') {
            try {
                const latestResult = await env['TVBOX_KV2'].get('latest_aggregated_result');
                if (!latestResult) {
                    return jsonResponse({ note: "尚未生成聚合数据，请先启动聚合任务。" }, 404);
                }
                // Manually create response but ensure CORS headers are present
                return new Response(latestResult, {
                    headers: {
                        'Content-Type': 'application/json;charset=UTF-8',
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            } catch (e) {
                return jsonResponse({ handler: 'subscribe', error: String((e && e.message) || e), stack: String((e && e.stack) || ''), envKeys: Object.keys(env), kvType: typeof env['TVBOX_KV2'] }, 500);
            }
        }

        // If no API route matches, serve the static assets.
        return env.ASSETS.fetch(request);
    }
};
