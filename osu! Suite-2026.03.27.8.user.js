// ==UserScript==
// @name         osu! Suite
// @namespace    http://tampermonkey.net/
// @version      2026.03.28.3
// @description  ok
// @author       Bei
// @match        https://osu.ppy.sh/*
// @match        https://new.ppy.sh/*
// @match        *://osu.ppy.sh/wiki/*/Ranking_criteria/osu!mania*
// @match        *://osu.ppy.sh/wiki/*/Ranking_criteria/osu%21mania*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @connect      osu.ppy.sh
// @connect      tenor.googleapis.com
// @connect      api.giphy.com
// @connect      localhost
// @connect      osu.ppy.sh
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════════════
    //  SAFETY CHECK - ONLY RUN ON OSU! SITES
    // ═══════════════════════════════════════════════════════════════════════════
    const currentHost = location.hostname;
    const isOsuSite = currentHost === 'osu.ppy.sh' || currentHost === 'new.ppy.sh';

    if (!isOsuSite) {
        // Don't run ANYTHING on non-osu sites
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  SHARED STORAGE
    // ═══════════════════════════════════════════════════════════════════════════
    const Store = {
        get:    (k, d)    => GM_getValue(k, d),
        set:    (k, v)    => GM_setValue(k, v),
        del:    (k)       => GM_deleteValue(k),
        getYTKey:   ()    => GM_getValue('yt_api_key', ''),
        setYTKey:   (v)   => GM_setValue('yt_api_key', v),
        getUsername:()    => GM_getValue('osu_username', ''),
        setUsername:(v)   => GM_setValue('osu_username', v),
        getTenorKey:()    => GM_getValue('tenor_api_key', ''),
        setTenorKey:(v)   => GM_setValue('tenor_api_key', v),
        getGiphyKey:()    => GM_getValue('giphy_api_key', ''),
        setGiphyKey:(v)   => GM_setValue('giphy_api_key', v),
        getOsuClientId:   ()  => GM_getValue('osu_client_id', ''),
        setOsuClientId:   (v) => GM_setValue('osu_client_id', v),
        getOsuClientSecret:() => GM_getValue('osu_client_secret', ''),
        setOsuClientSecret:(v)=> GM_setValue('osu_client_secret', v),
        getSessionToken:  ()  => GM_getValue('osu_session_token', ''),
        setSessionToken:  (v) => GM_setValue('osu_session_token', v),
        getSessionUser:   ()  => { try { return JSON.parse(GM_getValue('osu_session_user', 'null')); } catch { return null; } },
        setSessionUser:   (v) => GM_setValue('osu_session_user', JSON.stringify(v)),
        clearSession:     ()  => { GM_deleteValue('osu_session_token'); GM_deleteValue('osu_session_user'); },
        getOsuToken:      ()  => GM_getValue('osu_token', null),
        setOsuToken:      (v) => GM_setValue('osu_token', v),
        getOsuTokenExp:   ()  => GM_getValue('osu_token_exp', 0),
        setOsuTokenExp:   (v) => GM_setValue('osu_token_exp', v),
        getReviewToken:   ()  => GM_getValue('review_token', ''),
        setReviewToken:   (v) => GM_setValue('review_token', v),

        getBeatmapCache: (id) => {
            const raw = GM_getValue(`bm_cache_${id}`, null);
            if (!raw) return null;
            try { return JSON.parse(raw); } catch { return null; }
        },
        setBeatmapCache: (id, data) => {
            GM_setValue(`bm_cache_${id}`, JSON.stringify(data));
        },
        getSetCache: (id) => {
            const raw = GM_getValue(`bs_cache_${id}`, null);
            if (!raw) return null;
            try { return JSON.parse(raw); } catch { return null; }
        },
        setSetCache: (id, data) => {
            GM_setValue(`bs_cache_${id}`, JSON.stringify(data));
        },
    };

    // ═══════════════════════════════════════════════════════════════════════════
    //  TB DESIGN TOKENS & GLOBAL STYLES
    // ═══════════════════════════════════════════════════════════════════════════
    const TB_CSS = `
        :root {
            --tb-bg0: rgba(12, 12, 12, 0.97);
            --tb-bg1: rgba(12, 12, 12, 0.97);
            --tb-bg2: rgba(26, 26, 26, 0.6);
            --tb-border: rgba(255,255,255,0.06);
            --tb-border-hi: rgba(255,255,255,0.2);
            --tb-text: #e8e8ec;
            --tb-text-dim: rgba(255,255,255,0.45);
            --tb-text-dimmer: rgba(255,255,255,0.25);
            --tb-accent: #ff66aa;
            --tb-accent2: #6bb6ff;
            --tb-accent3: #ffd93d;
            --tb-green: #4caf50;
            --tb-red: #ff6b6b;
            --tb-orange: #f97316;
            --tb-purple: #a855f7;
            --tb-radius: 6px;
            --tb-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            --tb-mono: "Courier New", monospace;
        }

        @keyframes tb-slideIn  { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes tb-slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
        @keyframes tb-pulse    { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
        @keyframes tb-fadeIn   { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes tb-spin     { to { transform: rotate(360deg); } }
        @keyframes tb-glow     { 0%,100% { box-shadow: 0 0 4px rgba(255,102,170,0.4); } 50% { box-shadow: 0 0 10px rgba(255,102,170,0.8); } }

        /* ── Notification toast ── */
        .tb-toast {
            position: fixed; top: 20px; right: 20px; z-index: 999999;
            padding: 10px 16px; border-radius: var(--tb-radius);
            font-family: var(--tb-font); font-size: 11px; font-weight: 500;
            letter-spacing: 0.4px; border: 1px solid; backdrop-filter: blur(6px);
            box-shadow: 0 4px 16px rgba(0,0,0,0.7);
            animation: tb-slideIn 0.25s ease-out;
            pointer-events: none;
        }
        .tb-toast--info    { background: #999; border-color: #888; color: #000; }
        .tb-toast--success { background: #fff; border-color: #333; color: #000; }
        .tb-toast--warning { background: #666; border-color: #555; color: #fff; }
        .tb-toast--error   { background: #000; border-color: #fff; color: #fff; }

        /* ═══ AUTOFILLER PANEL ═══════════════════════════════════════════════ */
        .tb-af-container {
            position: fixed; bottom: 20px; right: 20px; z-index: 999999;
            font-family: var(--tb-font);
        }
        .tb-af-panel {
            background: var(--tb-bg0); border: 1px solid var(--tb-border);
            border-radius: var(--tb-radius); padding: 14px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.8);
            backdrop-filter: blur(4px); min-width: 340px;
            animation: tb-slideIn 0.3s cubic-bezier(.25,.8,.25,1);
        }
        .tb-af-header {
            text-align: center; margin-bottom: 12px; padding: 10px 14px;
            background: rgba(26, 26, 26, 0.8);
            border-bottom: 1px solid var(--tb-border);
            margin: -14px -14px 12px -14px;
        }
        .tb-af-title { color: var(--tb-text); font-size: 12px; font-weight: 600; letter-spacing: 0px; margin-bottom: 3px; }
        .tb-af-sub   { color: var(--tb-text-dimmer); font-size: 10px; letter-spacing: 0px; font-style: italic; }
        .tb-input {
            width: 100%; padding: 8px 10px; margin-bottom: 10px;
            background: rgba(0,0,0,0.5); border: 1px solid var(--tb-border);
            border-radius: 4px; color: var(--tb-text); font-size: 11px;
            font-family: var(--tb-font); box-sizing: border-box; transition: border-color 0.15s;
        }
        .tb-input:focus   { outline: none; border-color: var(--tb-border-hi); background: rgba(0,0,0,0.7); }
        .tb-input::placeholder { color: var(--tb-text-dimmer); }
        .tb-af-btns { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 10px; }
        .tb-btn {
            padding: 7px 12px; background: var(--tb-bg2);
            border: 1px solid var(--tb-border); border-radius: 4px;
            color: rgba(255,255,255,0.7); font-size: 11px; font-weight: 400;
            font-family: var(--tb-font); cursor: pointer; transition: all 0.15s;
            letter-spacing: 0px; text-transform: none;
        }
        .tb-btn:hover { background: rgba(255,255,255,0.10); border-color: var(--tb-border-hi); color: var(--tb-text); transform: translateY(-1px); }
        .tb-btn:active { transform: translateY(0); background: rgba(255,255,255,0.06); }
        .tb-af-status {
            display: flex; align-items: center; justify-content: center; gap: 10px;
            font-size: 10px; color: var(--tb-text-dimmer); padding: 7px 10px;
            background: rgba(255,255,255,0.02); border-radius: 4px;
            border: 1px solid var(--tb-border); margin-bottom: 10px;
            letter-spacing: 0.5px;
        }
        .tb-dot {
            width: 5px; height: 5px; border-radius: 50%;
            background: rgba(255,255,255,0.15); transition: all 0.2s; flex-shrink: 0;
        }
        .tb-dot--on { background: var(--tb-green); box-shadow: 0 0 6px rgba(76,175,80,0.6); animation: tb-pulse 2s infinite; }
        .tb-divider { height: 1px; background: var(--tb-border); margin: 10px 0; }
        .tb-af-hint { font-size: 9px; color: var(--tb-text-dimmer); text-align: center; line-height: 1.7; letter-spacing: 0.4px; font-style: italic; }

        /* ═══ BEATMAP ANALYZER — compact inline stats ══════════════════════ */
        /*
         * We inject a SINGLE flex row (.tb-stats-row) BELOW the existing
         * .beatmapset-panel__info-row--stats row so the original play/fav
         * counts are never touched and the card height increases by exactly
         * one compact row (~18px).
         */
        /* Each pill */
        .tb-pill {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            padding: 0 6px;
            height: 18px;
            border-radius: 3px;
            font-size: 10px;
            font-family: var(--tb-mono, monospace);
            font-weight: 600;
            letter-spacing: 0.2px;
            white-space: nowrap;
            flex-shrink: 0;
            margin-right: 3px;
            border: 1px solid transparent;
        }
        .tb-pill i { font-size: 10px; opacity: 0.75; }

        /* Type colours */
        .tb-pill--keys   { background: rgba(107,182,255,0.12); border-color: rgba(107,182,255,0.25); color: #6bb6ff; }
        .tb-pill--nps    { background: rgba(255,211,61,0.10);  border-color: rgba(255,211,61,0.2);  color: #ffd93d; }
        .tb-pill--rc     { background: rgba(56,189,248,0.10);  border-color: rgba(56,189,248,0.25); color: #38bdf8; }
        .tb-pill--hyb    { background: rgba(168,85,247,0.10);  border-color: rgba(168,85,247,0.25); color: #c084fc; }
        .tb-pill--ln     { background: rgba(249,115,22,0.12);  border-color: rgba(249,115,22,0.3);  color: #fb923c; }
        .tb-pill--farm-s { background: rgba(255,215,0,0.15);   border-color: rgba(255,215,0,0.4);   color: #ffd700; }
        .tb-pill--farm-a { background: rgba(192,192,192,0.12); border-color: rgba(192,192,192,0.3); color: #c0c0c0; }
        .tb-pill--farm-b { background: rgba(184,115,51,0.12);  border-color: rgba(184,115,51,0.3);  color: #cd7f32; }
        .tb-pill--farm-c { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1); color: rgba(255,255,255,0.4); }
        .tb-pill--farm-d { background: rgba(255,107,107,0.08); border-color: rgba(255,107,107,0.2); color: #ff6b6b; }

        /* Loading shimmer */
        .tb-pill--loading { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.06); color: rgba(255,255,255,0.2); animation: tb-pulse 1.4s ease infinite; }

        /* BPM badge on card (new feature) */
        .tb-bpm-badge {
            font-size: 9.5px; font-family: var(--tb-mono, monospace); font-weight: 700;
            color: rgba(255,255,255,0.35); margin-left: 4px; letter-spacing: 0.3px;
        }

        /* ═══ GIF FAVORITES ═══════════════════════════════════════════════════ */
        .tb-gif-button { margin-right: 0 !important; }

        .tb-gif-panel {
            position: absolute; bottom: calc(100% + 8px); right: 0;
            width: 440px; max-height: 580px;
            background: var(--tb-bg1); border: 1px solid var(--tb-border);
            border-radius: var(--tb-radius);
            box-shadow: 0 8px 24px rgba(0,0,0,0.8);
            backdrop-filter: blur(4px); z-index: 99999;
            display: none; overflow: hidden;
            font-family: var(--tb-font);
            animation: tb-fadeIn 0.2s ease-out;
        }
        .tb-gif-panel.open { display: block; }

        .tb-gif-header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 14px; background: rgba(26, 26, 26, 0.8);
            border-bottom: 1px solid var(--tb-border);
        }
        .tb-gif-title { color: var(--tb-text); font-size: 12px; font-weight: 600; letter-spacing: 0px; }
        .tb-gif-hbtns { display: flex; gap: 6px; }
        .tb-gif-hbtn {
            padding: 5px 12px; background: var(--tb-bg2);
            border: 1px solid var(--tb-border); border-radius: 4px;
            color: rgba(255,255,255,0.7); font-size: 11px; cursor: pointer;
            transition: all 0.15s;
        }
        .tb-gif-hbtn:hover { background: rgba(255,255,255,0.09); color: var(--tb-text); border-color: var(--tb-border-hi); }

        .tb-gif-tabs { display: flex; background: var(--tb-bg0); border-bottom: 1px solid var(--tb-border); }
        .tb-gif-tab {
            flex: 1; padding: 10px 6px; background: transparent;
            border: none; color: var(--tb-text-dim); cursor: pointer;
            font-size: 11px; font-family: var(--tb-font); font-weight: 400;
            letter-spacing: 0px; text-transform: none; transition: all 0.15s;
        }
        .tb-gif-tab:hover   { background: rgba(255,255,255,0.04); color: var(--tb-text); }
        .tb-gif-tab.active  { background: rgba(255,255,255,0.03); color: var(--tb-accent2); border-bottom: 2px solid var(--tb-accent2); }

        .tb-gif-body { display: none; }
        .tb-gif-body.active { display: block; }

        .tb-gif-provbar {
            padding: 7px 12px; background: rgba(0,0,0,0.3);
            border-bottom: 1px solid var(--tb-border);
            display: flex; align-items: center; gap: 8px;
            font-size: 10px; color: var(--tb-text-dimmer); letter-spacing: 0.4px;
        }
        .tb-gif-prov {
            padding: 3px 10px; border-radius: 10px; border: 1px solid var(--tb-border);
            background: rgba(255,255,255,0.04); color: var(--tb-text-dim);
            font-size: 10px; cursor: pointer; transition: all 0.15s; font-weight: 600; letter-spacing: 0.5px;
        }
        .tb-gif-prov:hover  { background: rgba(255,255,255,0.09); color: var(--tb-text); }
        .tb-gif-prov.active { background: rgba(107,182,255,0.1); border-color: rgba(107,182,255,0.4); color: var(--tb-accent2); }

        .tb-gif-searchbar { padding: 10px 12px; background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--tb-border); }

        .tb-gif-grid {
            max-height: 310px; overflow-y: auto; padding: 8px;
            display: grid; grid-template-columns: repeat(2,1fr); gap: 8px;
            background: var(--tb-bg2);
        }
        .tb-gif-empty {
            text-align: center; padding: 32px 16px;
            color: var(--tb-text-dimmer); font-size: 11px; line-height: 1.8;
            grid-column: 1/-1;
        }
        .tb-gif-loading { text-align: center; padding: 24px; color: var(--tb-text-dim); grid-column: 1/-1; font-size: 11px; }
        .tb-spinner {
            display: inline-block; width: 14px; height: 14px;
            border: 2px solid rgba(255,255,255,0.12); border-radius: 50%;
            border-top-color: var(--tb-accent2);
            animation: tb-spin 0.9s linear infinite; vertical-align: middle; margin-right: 6px;
        }

        .tb-gif-card {
            position: relative; border-radius: 4px; overflow: hidden;
            cursor: pointer; background: rgba(0,0,0,0.5);
            border: 2px solid transparent; transition: all 0.15s;
            display: flex; align-items: center; justify-content: center;
            min-height: 80px; padding: 4px;
        }
        .tb-gif-card:hover { border-color: var(--tb-accent2); transform: scale(1.02); }
        .tb-gif-card img { max-width: 100%; max-height: 150px; object-fit: contain; display: block; border-radius: 2px; }
        .tb-gif-card-fav {
            position: absolute; top: 4px; right: 4px;
            background: rgba(0,0,0,0.8); color: var(--tb-accent);
            border: none; border-radius: 50%; width: 22px; height: 22px;
            cursor: pointer; display: flex; align-items: center; justify-content: center;
            font-size: 11px; opacity: 0; transition: all 0.15s;
        }
        .tb-gif-card:hover .tb-gif-card-fav { opacity: 1; }

        .tb-fav-card {
            position: relative; border-radius: 4px; overflow: hidden;
            cursor: pointer; background: rgba(0,0,0,0.5);
            border: 2px solid transparent; transition: all 0.15s;
            display: flex; align-items: center; justify-content: center;
            min-height: 80px; padding: 4px;
        }
        .tb-fav-card:hover      { border-color: var(--tb-accent2); transform: scale(1.02); }
        .tb-fav-card.unfavd     { opacity: 0.5; border-color: rgba(255,255,255,0.1) !important; }
        .tb-fav-card img        { max-width: 100%; max-height: 200px; object-fit: contain; display: block; }
        .tb-fav-heart {
            position: absolute; top: 4px; right: 4px;
            background: rgba(0,0,0,0.8); padding: 3px 5px; border-radius: 4px;
            color: var(--tb-accent); font-size: 12px; cursor: pointer; transition: all 0.15s;
        }
        .tb-fav-heart.off { color: rgba(255,255,255,0.3); }
        .tb-fav-heart:hover { transform: scale(1.15); }

        .tb-gif-addsec { padding: 12px; background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--tb-border); }
        .tb-gif-hint { font-size: 10px; color: var(--tb-text-dimmer); margin: 6px 0; line-height: 1.6; }
        .tb-gif-preview { display: none; padding: 10px 12px; border-bottom: 1px solid var(--tb-border); }
        .tb-gif-preview.show { display: block; }
        .tb-gif-preview img { max-width: 100%; max-height: 180px; object-fit: contain; border-radius: 4px; display: block; margin: 0 auto 6px; }
        .tb-gif-prevurl { font-size: 10px; color: var(--tb-text-dimmer); word-break: break-all; }

        .tb-gif-settings { padding: 14px; background: var(--tb-bg2); max-height: 400px; overflow-y: auto; }
        .tb-key-group { margin-bottom: 16px; }
        .tb-key-label {
            color: var(--tb-text-dim); font-size: 11px; font-weight: 600;
            letter-spacing: 0px; text-transform: none; margin-bottom: 6px;
            display: flex; align-items: center; gap: 6px;
        }
        .tb-key-badge {
            font-size: 9px; padding: 1px 6px; border-radius: 8px;
            font-weight: 600; letter-spacing: 0.3px;
        }
        .tb-key-badge.ok   { background: rgba(76,175,80,0.15); color: var(--tb-green); border: 1px solid rgba(76,175,80,0.3); }
        .tb-key-badge.warn { background: rgba(255,107,107,0.1); color: var(--tb-text-dimmer); border: 1px solid var(--tb-border); }
        .tb-key-input {
            width: 100%; padding: 7px 10px; background: rgba(0,0,0,0.5);
            border: 1px solid var(--tb-border); border-radius: 4px;
            color: var(--tb-text); font-size: 11px; font-family: var(--tb-mono);
            box-sizing: border-box; margin-bottom: 6px;
        }
        .tb-key-input:focus { outline: none; border-color: var(--tb-border-hi); }
        .tb-key-actions { display: flex; gap: 6px; margin-bottom: 6px; }
        .tb-key-save {
            padding: 5px 12px; background: rgba(107,182,255,0.12);
            border: 1px solid rgba(107,182,255,0.3); border-radius: 4px;
            color: var(--tb-accent2); font-size: 10px; font-weight: 700;
            letter-spacing: 0.5px; cursor: pointer; transition: all 0.15s;
        }
        .tb-key-save:hover { background: rgba(107,182,255,0.2); }
        .tb-key-clear {
            padding: 5px 10px; background: rgba(255,255,255,0.04);
            border: 1px solid var(--tb-border); border-radius: 4px;
            color: var(--tb-text-dim); font-size: 10px; cursor: pointer; transition: all 0.15s;
        }
        .tb-key-clear:hover { background: rgba(255,255,255,0.08); color: var(--tb-text); }
        .tb-key-desc { font-size: 10px; color: var(--tb-text-dimmer); line-height: 1.6; }
        .tb-key-desc a { color: var(--tb-accent2); text-decoration: none; }
        .tb-key-desc a:hover { text-decoration: underline; }
        .tb-key-msg { font-size: 10px; padding: 4px 8px; border-radius: 4px; margin-top: 4px; display: none; }
        .tb-key-msg.ok  { background: rgba(76,175,80,0.1);  color: var(--tb-green); display: block; }
        .tb-key-msg.err { background: rgba(255,107,107,0.1); color: var(--tb-red);  display: block; }

        .tb-remind {
            padding: 7px 12px; background: rgba(107,182,255,0.07);
            border-left: 2px solid rgba(107,182,255,0.4);
            font-size: 10px; color: rgba(107,182,255,0.8); letter-spacing: 0.3px;
        }

        /* ═══ BEATMAP ANALYZER — force stats row single line ═══════════════ */
        .beatmapset-panel__info-row--stats {
            flex-wrap: nowrap !important;
            height: auto !important;
            min-height: 0 !important;
            overflow: hidden !important;
            display: flex !important;
            align-items: center !important;
            gap: 0 !important;
        }
        .beatmapset-panel__info-row--stats .beatmapset-panel__stats-item {
            flex-shrink: 1 !important;
            min-width: 0 !important;
            white-space: nowrap !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            font-size: 12px !important;
            padding: 0 3px !important;
            margin: 0 !important;
        }
        .beatmapset-panel__stats-item--date { display: none !important; }
        .beatmapset-panel__info-row--stats .beatmapset-panel__stats-item-icon {
            margin-right: 2px !important;
        }

        /* ═══ QUICK ACTIONS OVERLAY on beatmapset cards ═══════════════════ */
        .tb-card-overlay {
            position: absolute;
            top: 4px; right: 4px;
            display: flex; flex-direction: column; gap: 3px;
            opacity: 0; transition: opacity 0.15s;
            pointer-events: none;
            z-index: 10;
        }
        .beatmapset-panel:hover .tb-card-overlay,
        .beatmapset-panel--active .tb-card-overlay {
            opacity: 1;
            pointer-events: all;
        }
        .tb-qbtn {
            display: flex; align-items: center; justify-content: center;
            width: 22px; height: 22px; border-radius: 4px;
            background: rgba(0,0,0,0.75); border: 1px solid rgba(255,255,255,0.12);
            color: rgba(255,255,255,0.6); font-size: 9px; cursor: pointer;
            text-decoration: none; transition: all 0.12s;
        }
        .tb-qbtn:hover { background: rgba(255,255,255,0.15); color: #fff; border-color: rgba(255,255,255,0.3); transform: scale(1.1); }
        .tb-qbtn--copy.copied { background: rgba(76,175,80,0.3); border-color: rgba(76,175,80,0.5); color: var(--tb-green); }

        /* ═══ DRAG SELECT & BULK DOWNLOAD ════════════════════════════════════ */
        .beatmapset-panel.tb-selected {
            outline: 2px solid var(--tb-accent2) !important;
            outline-offset: -2px !important;
            background: rgba(107,182,255,0.06) !important;
        }
        .tb-bulk-bar {
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            z-index: 999999; display: flex; align-items: center; gap: 10px;
            background: var(--tb-bg0); border: 1px solid var(--tb-border-hi);
            border-radius: 999px; padding: 8px 16px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.9);
            backdrop-filter: blur(8px); font-family: var(--tb-font);
            animation: tb-fadeIn 0.2s ease-out;
            white-space: nowrap;
        }
        .tb-bulk-bar.hidden { display: none; }
        .tb-bulk-count {
            font-size: 12px; font-weight: 700; color: var(--tb-accent2);
            min-width: 24px; text-align: center;
        }
        .tb-bulk-label {
            font-size: 11px; color: var(--tb-text-dim);
        }
        .tb-bulk-sep { width: 1px; height: 16px; background: var(--tb-border-hi); }
        .tb-bulk-btn {
            padding: 5px 14px; border-radius: 999px; border: 1px solid;
            font-size: 11px; font-weight: 600; cursor: pointer;
            font-family: var(--tb-font); transition: all 0.15s;
        }
        .tb-bulk-btn--dl {
            background: rgba(107,182,255,0.15); border-color: rgba(107,182,255,0.4);
            color: var(--tb-accent2);
        }
        .tb-bulk-btn--dl:hover { background: rgba(107,182,255,0.3); }
        .tb-bulk-btn--dl.downloading {
            background: rgba(76,175,80,0.15); border-color: rgba(76,175,80,0.4);
            color: var(--tb-green); animation: tb-pulse 1s infinite;
        }
        .tb-bulk-btn--clear {
            background: transparent; border-color: var(--tb-border);
            color: var(--tb-text-dimmer);
        }
        .tb-bulk-btn--clear:hover { border-color: var(--tb-border-hi); color: var(--tb-text); }
        .tb-drag-hint {
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            z-index: 99997; font-size: 10px; color: var(--tb-text-dimmer);
            font-family: var(--tb-font); pointer-events: none;
            opacity: 0; transition: opacity 0.3s;
        }
        .tb-drag-hint.visible { opacity: 1; }
        .tb-drag-overlay {
            position: fixed; pointer-events: none; z-index: 999997;
            border: 1.5px dashed var(--tb-accent2);
            background: rgba(107,182,255,0.06);
            border-radius: 4px; display: none;
        }

        .tb-drag-overlay.active { display: block; }

        /* ═══ DIFF SPIKE ═════════════════════════════════════════════════════ */
        .tb-spike-icon {
            display: inline-flex; align-items: center; justify-content: center;
            width: 14px; height: 14px;
            margin-left: 4px;
            cursor: default;
            flex-shrink: 0;
            vertical-align: middle;
            position: relative;
            top: -1px;
        }
        .tb-spike-icon svg {
            width: 14px; height: 14px;
            filter: drop-shadow(0 0 3px rgba(255,107,107,0.8));
            animation: tb-pulse 1.4s ease infinite;
        }
        .beatmapset-panel__beatmap-dot.tb-spike-dot-hi {
            outline: 2px solid rgba(255,107,107,0.9) !important;
            outline-offset: 1px !important;
            box-shadow: 0 0 6px rgba(255,107,107,0.7) !important;
            animation: tb-pulse 1.4s ease infinite !important;
        }

        /* ═══ INLINE CLASS FILTER ════════════════════════════════════════════ */
        .tb-inline-filter__items {
            display: flex !important;
            flex-wrap: wrap !important;
        }
        .tb-inline-filter .beatmapsets-search-filter__header {
            padding-right: 0 !important;
            margin-right: 0 !important;
        }

        /* ═══ EQUAL SPACING FOR DIFFICULTY DOTS ═════════════════════════════ */
        .beatmapset-panel__extra-item--dots {
            display: flex !important;
            align-items: center !important;
            gap: 3px !important;
            flex-wrap: nowrap !important;
        }
        .beatmapset-panel__beatmap-dot {
            flex-shrink: 0 !important;
            margin: 0 !important;
        }
        @keyframes tb-glow-red {
            0%,100% { box-shadow: 0 0 4px rgba(255,107,107,0.3); }
            50%      { box-shadow: 0 0 10px rgba(255,107,107,0.7); }
        }

        /* card needs relative + full width for heatmap to span */
        .beatmapset-panel {
            position: relative !important;
            overflow: visible !important;
        }
        .beatmapset-panel__cover-col--play {
            position: relative !important;
            overflow: hidden !important;
        }
        .beatmapset-panel__cover-col--info {
            position: relative !important;
            overflow: hidden !important;
        }
    `;

if (isOsuSite) {
    GM_addStyle(TB_CSS);
}

    // ═══════════════════════════════════════════════════════════════════════════
    //  SHARED UTILITIES
    // ═══════════════════════════════════════════════════════════════════════════
    function notify(msg, type = 'info', duration = 3000) {
        const el = document.createElement('div');
        el.className = `tb-toast tb-toast--${type}`;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.animation = 'tb-slideOut 0.25s ease-out forwards';
            setTimeout(() => el.remove(), 250);
        }, duration);
    }

    function gmXhr(url, timeout = 12000) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout,
                onload:    r => resolve(r),
                onerror:   () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timeout')),
            });
        });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ═══════════════════════════════════════════════════════════════════════════
    //  MODULE 1 — BEATMAP ANALYZER  (osu.ppy.sh/beatmapsets)
    // ═══════════════════════════════════════════════════════════════════════════
    if (location.hostname === 'osu.ppy.sh' || location.hostname === 'new.ppy.sh') {

        // ── osu! API v2 client ────────────────────────────────────────────────
        const OsuAPI = {
            async getToken() {
                const now = Date.now();
                if (Store.getOsuToken() && Store.getOsuTokenExp() > now + 60000)
                    return Store.getOsuToken();
                const id  = Store.getOsuClientId();
                const sec = Store.getOsuClientSecret();
                if (!id || !sec) return null;
                return new Promise(resolve => {
                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: 'https://osu.ppy.sh/oauth/token',
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({ client_id: id, client_secret: sec, grant_type: 'client_credentials', scope: 'public' }),
                        timeout: 10000,
                        onload: r => {
                            try {
                                const d = JSON.parse(r.responseText);
                                if (d.access_token) {
                                    Store.setOsuToken(d.access_token);
                                    Store.setOsuTokenExp(now + (d.expires_in || 86400) * 1000);
                                    resolve(d.access_token);
                                } else resolve(null);
                            } catch { resolve(null); }
                        },
                        onerror:   () => resolve(null),
                        ontimeout: () => resolve(null),
                    });
                });
            },
            async get(path) {
                const token = await this.getToken();
                if (!token) return null;
                return new Promise(resolve => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `https://osu.ppy.sh/api/v2/${path}`,
                        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
                        timeout: 10000,
                        onload: r => {
                            try { resolve(JSON.parse(r.responseText)); }
                            catch { resolve(null); }
                        },
                        onerror:   () => resolve(null),
                        ontimeout: () => resolve(null),
                    });
                });
            },
        };

        // ── Score estimator helpers ───────────────────────────────────────────
        // osu!mania PP at 1.0x (nomod) and 1.5x (DT) speed multipliers
        // difficulty_value = (5 * max(1, sr/0.2) - 4)^2.2 / 135  (official formula component)
        // scaled by ~98% accuracy factor; no note count/OD correction available client-side
        function estimatePP(sr) {
            if (!sr || sr <= 0) return 0;
            const ACC_FACTOR = 0.875; // ~98% acc scaling
            const diffVal = (v) => Math.pow(Math.max(1, v / 0.2) * 5 - 4, 2.2) / 135;
            const nmPP = Math.round(diffVal(sr) * ACC_FACTOR * 0.95);
            // DT: effective SR ~1.4x but tighter hit windows reduce gains at high SR
            const dtMult = 1.55 + 0.35 * Math.min(1, (sr - 2) / 6); // ~1.55× at SR2, ~1.90× at SR8+
            const dtPP = Math.round(nmPP * Math.max(1.55, dtMult));
            return { nm: nmPP, dt: dtPP };
        }

        function gradeFromAcc(acc) {
            if (acc >= 100)  return { g: 'SS', color: '#ffd700' };
            if (acc >= 99)   return { g: 'S',  color: '#ffd700' };
            if (acc >= 95)   return { g: 'A',  color: '#4caf50' };
            if (acc >= 90)   return { g: 'B',  color: '#6bb6ff' };
            if (acc >= 80)   return { g: 'C',  color: '#fb923c' };
            return                  { g: 'D',  color: '#ff6b6b' };
        }

        // Cache: beatmapId → { played: bool, bestAcc: number|null, bestPP: number|null }
        const playedCache = new Map();

        async function fetchPlayedStatus(beatmapId, sr) {
            if (playedCache.has(beatmapId)) return playedCache.get(beatmapId);
            const username = Store.getUsername();
            if (!username) { playedCache.set(beatmapId, null); return null; }

            // look up user id first (cached)
            let userId = Store.get('osu_user_id', null);
            if (!userId) {
                const u = await OsuAPI.get(`users/${encodeURIComponent(username)}/mania`);
                if (!u?.id) { playedCache.set(beatmapId, null); return null; }
                userId = u.id;
                Store.set('osu_user_id', userId);
            }

            const scores = await OsuAPI.get(`beatmaps/${beatmapId}/scores/users/${userId}?mode=mania`);
            if (!scores?.score) {
                const result = { played: false, bestAcc: null, bestPP: null };
                playedCache.set(beatmapId, result);
                return result;
            }
            const best = scores.score;
            const acc  = best.accuracy != null ? +(best.accuracy * 100).toFixed(2) : null;
            const pp   = best.pp != null ? Math.round(best.pp) : (acc ? estimatePP(sr, acc, od) : null);
            const result = { played: true, bestAcc: acc, bestPP: pp };
            playedCache.set(beatmapId, result);
            return result;
        }

        const ATTR_DONE = 'data-tb-analyzed';
        const bsCache   = new Map();
        const pending   = new Set();
        const queue     = [];
        let draining    = false;

        // ── Math ──────────────────────────────────────────────────────────────
        function calcLNPct(bm) {
            const ln = bm.count_sliders || 0, rice = bm.count_circles || 0;
            const tot = ln + rice; return tot ? Math.round(ln / tot * 100) : 0;
        }
        function calcNPS(bm) {
            const notes = (bm.count_circles||0) + (bm.count_sliders||0) + (bm.count_spinners||0);
            return +(notes / Math.max(bm.hit_length || bm.total_length || 1, 1)).toFixed(1);
        }
        function calcFarmScore(bs, hard) {
            if (!hard) return 0;
            const sr       = hard.difficulty_rating || 0;
            const lnPct    = calcLNPct(hard);
            const nps      = calcNPS(hard);
            const favs     = bs.favourite_count || 0;
            const plays    = bs.play_count || 0;
            const srScore    = Math.min(100, (sr / 10) * 100);
            const npsScore   = Math.min(100, (nps / 20) * 100);
            const favsScore  = Math.min(100, Math.log10(Math.max(1, favs)) / 4 * 100);
            const playsScore = Math.min(100, Math.log10(Math.max(1, plays)) / 5 * 100);
            const lnScore    = 100 - Math.abs(lnPct - 40) * 1.2;
            return Math.round(srScore * 0.35 + npsScore * 0.25 + favsScore * 0.2 + playsScore * 0.1 + lnScore * 0.1);
        }
        function farmGrade(score) {
            if (score >= 90) return 'S';
            if (score >= 75) return 'A';
            if (score >= 60) return 'B';
            if (score >= 40) return 'C';
            return 'D';
        }
        function topDiff(bs) {
            if (!bs.beatmaps?.length) return null;
            return bs.beatmaps.reduce((a,b) => (b.difficulty_rating||0) > (a.difficulty_rating||0) ? b : a);
        }
        function lnLabel(pct) { return pct >= 50 ? 'LN' : pct >= 20 ? 'HYB' : 'RC'; }
        function lnPillClass(pct) { return pct >= 50 ? 'tb-pill--ln' : pct >= 20 ? 'tb-pill--hyb' : 'tb-pill--rc'; }
        function farmPillClass(grade) {
            return { S:'tb-pill--farm-s', A:'tb-pill--farm-a', B:'tb-pill--farm-b', C:'tb-pill--farm-c', D:'tb-pill--farm-d' }[grade] || 'tb-pill--farm-d';
        }

        // ── Direct osu! scrape (no proxy needed) ─────────────────────────────
        function slimBS(bs) {
            const keepDiff = d => ({
                id:                d.id,
                mode_int:          d.mode_int,
                difficulty_rating: d.difficulty_rating,
                cs:                d.cs,
                bpm:               d.bpm,
                hit_length:        d.hit_length,
                total_length:      d.total_length,
                count_circles:     d.count_circles,
                count_sliders:     d.count_sliders,
                count_spinners:    d.count_spinners,
            });
            return {
                id:              bs.id,
                bpm:             bs.bpm,
                play_count:      bs.play_count,
                favourite_count: bs.favourite_count,
                beatmaps:        (bs.beatmaps || []).map(keepDiff),
                _cached:         Date.now(),
            };
        }

        function fetchBS(id) {
            return new Promise((resolve, reject) => {
                if (bsCache.has(id)) { resolve(bsCache.get(id)); return; }
                const stored = Store.getBeatmapCache(`bs_${id}`);
            if (stored && stored._cached && (Date.now() - stored._cached) < 7 * 24 * 60 * 60 * 1000) { bsCache.set(id, stored); resolve(stored); return; }
                GM_xmlhttpRequest({
                    method: 'GET', url: `https://osu.ppy.sh/beatmapsets/${id}`, timeout: 15000,
                    onload: r => {
                        if (r.status === 200) {
                            try {
                                const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
                                const tag = doc.querySelector('#json-beatmapset') || doc.querySelector('[data-initial-data]');
                                if (!tag) { reject(new Error('No beatmapset data')); return; }
                                const full = JSON.parse(tag.textContent);
                                const d = slimBS(full);
                                bsCache.set(id, d);
                                Store.setBeatmapCache(`bs_${id}`, d);
                                resolve(d);
                            } catch(e) { reject(e); }
                        } else { reject(new Error(`HTTP ${r.status}`)); }
                    },
                    onerror:   () => reject(new Error('network error')),
                    ontimeout: () => reject(new Error('timeout')),
                });
            });
        }

        function showLoading(card) {
            // Only add loading pill if stats row not yet injected
            if (card.querySelector('.tb-stats-row')) return;
            const statsRow = card.querySelector('.beatmapset-panel__info-row--stats');
            if (!statsRow) return;

            const row = document.createElement('div');
            row.className = 'tb-stats-row tb-stats-row--loading';
            const pill = document.createElement('div');
            pill.className = 'tb-pill tb-pill--loading';
            pill.innerHTML = '<i class="fa-fw fas fa-circle-notch fa-spin"></i><span>loading…</span>';
            row.appendChild(pill);
            statsRow.parentNode.insertBefore(row, statsRow.nextSibling);
        }

        function clearLoading(card) {
            card.querySelectorAll('.tb-stats-row--loading').forEach(el => el.remove());
        }

        function injectStats(card, bs) {
            clearLoading(card);
            const id = getCardId(card);
            if (id) card.setAttribute(ATTR_DONE, id);
            const statsRow = card.querySelector('.beatmapset-panel__info-row--stats');
            if (!statsRow) return;
            if (statsRow.querySelector('[data-tb-injected]')) {
                injectSpikeBadge(card, bs);
                return;
            }

            const hard = topDiff(bs);
            if (!hard) return;

            const lnPct    = calcLNPct(hard);
            const nps      = calcNPS(hard);
            const keys     = Math.round(hard.cs || 4);
            const bpm      = hard.bpm || bs.bpm || 0;
            const label    = lnLabel(lnPct);
            const farm     = calcFarmScore(bs, hard);
            const grade    = farmGrade(farm);

            function makeStatItem(iconCls, text, titleAttr) {
                const div = document.createElement('div');
                div.className = 'beatmapset-panel__stats-item';
                div.setAttribute('data-tb-injected', '1');
                if (titleAttr) { div.setAttribute('data-orig-title', titleAttr); div.title = titleAttr; }
                div.innerHTML = `<span class="beatmapset-panel__stats-item-icon"><i class="fa-fw ${iconCls}"></i></span><span>${text}</span>`;
                return div;
            }

            statsRow.appendChild(makeStatItem('fas fa-stream',        `${label} ${lnPct}%`, `LN: ${lnPct}% — ${label === 'LN' ? 'Long Note heavy' : label === 'HYB' ? 'Hybrid' : 'Rice'}`));
            statsRow.appendChild(makeStatItem('fas fa-star',          `F: ${grade}${farm}`,  `Farm Score ${farm}/100 (Grade ${grade})`));

            // ── Played / score estimator (async, non-blocking) ────────────────
            const bmId = hard.id;
            (async () => {
                const status = await fetchPlayedStatus(bmId, hard.difficulty_rating);
                if (!status) return;
                // remove stale played pills if re-injecting
                statsRow.querySelectorAll('[data-tb-played]').forEach(e => e.remove());
                if (status.played) {
                    const accGrade = gradeFromAcc(status.bestAcc ?? 0);
                    const playedEl = document.createElement('div');
                    playedEl.className = 'beatmapset-panel__stats-item';
                    playedEl.setAttribute('data-tb-injected', '1');
                    playedEl.setAttribute('data-tb-played', '1');
                    playedEl.title = status.bestAcc
                        ? `Your best: ${status.bestAcc}% — ~${status.bestPP}pp`
                        : 'You have played this map';
                    playedEl.innerHTML = `
                        <span class="beatmapset-panel__stats-item-icon">
                            <i class="fa-fw fas fa-check-circle" style="color:${accGrade.color}"></i>
                        </span>
                        <span style="color:${accGrade.color};font-weight:600">
                            ${status.bestAcc != null ? status.bestAcc + '%' : '✓'}
                            ${status.bestPP  != null ? ' ~' + status.bestPP + 'pp' : ''}
                        </span>`;
                    statsRow.appendChild(playedEl);
                } else {
                    // Show NM → DT pp range for unplayed maps
                    const pp     = estimatePP(hard.difficulty_rating);
                    const estEl  = document.createElement('div');
                    estEl.className = 'beatmapset-panel__stats-item';
                    estEl.setAttribute('data-tb-injected', '1');
                    estEl.setAttribute('data-tb-played', '1');
                    estEl.title = `Estimated PP: ~${pp.nm}pp (NM) → ~${pp.dt}pp (DT)`;
                    estEl.innerHTML = `
                        <span class="beatmapset-panel__stats-item-icon">
                            <i class="fa-fw fas fa-chart-line" style="color:rgba(255,255,255,0.3)"></i>
                        </span>
                        <span style="color:rgba(255,255,255,0.3)">~${pp.nm}→${pp.dt}pp</span>`;
                    statsRow.appendChild(estEl);
                }
            })();

            // ── Quick-action overlay buttons ──────────────────────────────────
            if (!card.querySelector('.tb-card-overlay')) {
                // Make card position:relative if not already
                const compStyle = getComputedStyle(card);
                if (compStyle.position === 'static') card.style.position = 'relative';

                const overlay = document.createElement('div');
                overlay.className = 'tb-card-overlay';

                card.appendChild(overlay);
            }
        }

        // ── Diff spike detector ───────────────────────────────────────────────
        function detectSpike(bs) {
            const diffs = (bs.beatmaps || [])
                .filter(d => d.mode_int === 3)
                .map(d => d.difficulty_rating || 0)
                .sort((a,b) => a - b);
            if (diffs.length < 2) return null;

            const topTwo   = diffs.slice(-2);
            const rest     = diffs.slice(0, -1);
            const restAvg  = rest.reduce((a,b) => a+b, 0) / rest.length;
            const spike    = topTwo[1] - topTwo[0];       // gap between top and 2nd
            const overAll  = topTwo[1] - restAvg;         // gap vs whole spread avg

            // Flag if top diff is >1.5★ above the 2nd AND >2★ above average
            if (spike >= 1.5 && overAll >= 2.0) {
                return { spike: spike.toFixed(1), top: topTwo[1].toFixed(1) };
            }
            return null;
        }

        function injectSpikeBadge(card, bs) {
            if (card.querySelector('.tb-spike-icon')) return;
            const spike = detectSpike(bs);
            if (!spike) return;

            // find the extra-item that has the dots
            const dotsWrap = card.querySelector('.beatmapset-panel__extra-item--dots');
            if (!dotsWrap) return;

            // highlight the top diff dot — last dot in the list
            const dots = dotsWrap.querySelectorAll('.beatmapset-panel__beatmap-dot');
            if (dots.length) dots[dots.length - 1].classList.add('tb-spike-dot-hi');

            // warning icon after the dots
            const icon = document.createElement('span');
            icon.className = 'tb-spike-icon';
            icon.title = `Diff spike: top diff (${spike.top}★) is +${spike.spike}★ above the spread`;
            icon.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 1.5L14.5 13.5H1.5L8 1.5Z" fill="rgba(255,107,107,0.2)" stroke="#ff6b6b" stroke-width="1.5" stroke-linejoin="round"/>
                <path d="M8 6V9.5" stroke="#ff6b6b" stroke-width="1.5" stroke-linecap="round"/>
                <circle cx="8" cy="11.5" r="0.75" fill="#ff6b6b"/>
            </svg>`;
            dotsWrap.appendChild(icon);
        }

        // ── Queue / drain — FIXED: retry on reload, use MutationObserver aggressively ─
        let proxyOk = true;

        const CONCURRENCY = 16;

        async function drainOne({ id, card }) {
            if (!document.contains(card)) return;
            showLoading(card);
            try {
                const bs = await fetchBS(id);
                injectStatsAndFilter(card, bs);
            } catch(e) {
                clearLoading(card);
                if (e.message !== 'network error' && e.message !== 'timeout') {
                    card.setAttribute('data-tb-failed', '1');
                } else {
                    card.removeAttribute(ATTR_DONE);
                    pending.delete(id);
                }
            }
        }

        async function drain() {
            if (draining) return; draining = true;
            while (queue.length > 0) {
                const batch = [];
                while (batch.length < CONCURRENCY && queue.length > 0)
                    batch.push(queue.shift());
                await Promise.all(batch.map(item => drainOne(item)));
                await sleep(50);
            }
            draining = false;
        }

        function getCardId(card) {
            const link = card.querySelector('a[href*="/beatmapsets/"]');
            if (link) { const m = link.href.match(/\/beatmapsets\/(\d+)/); if (m) return m[1]; }
            const au = card.getAttribute('data-audio-url')||'';
            const m2 = au.match(/\/preview\/(\d+)\.mp3/); if (m2) return m2[1];
            for (const a of card.querySelectorAll('a[href]')) {
                const m3 = a.href.match(/\/beatmapsets\/(\d+)/); if (m3) return m3[1];
            }
            return null;
        }

        function scanCards() {
            document.querySelectorAll('.beatmapset-panel, .beatmapset-panel--inactive, .beatmapset-panel--active').forEach(card => {
                const id = getCardId(card);
                if (!id) return;

                // card already has injected stats and they match this id — skip
                // (never skip on fresh navigation — ATTR_DONE is cleared on route change)
                if (card.querySelector('[data-tb-injected]') && card.getAttribute(ATTR_DONE) === id && document.contains(card)) return;

                // data is in memory or GM cache — inject immediately without queuing
                const cached = bsCache.get(id) || (() => {
                    const s = Store.getBeatmapCache(`bs_${id}`);
                    if (s) { bsCache.set(id, s); return s; }
                })();
                if (cached) {
                    card.setAttribute(ATTR_DONE, id);
                    injectStats(card, cached);
                    return;
                }

                // already queued or fetching — just show loading and let drain handle it
                if (pending.has(id)) {
                    showLoading(card);
                    return;
                }

                if (card.hasAttribute('data-tb-failed')) return;

                card.setAttribute(ATTR_DONE, id);
                pending.add(id);
                queue.push({ id, card });
            });
            if (queue.length) drain();
        }

        // ── CLASS SELECTOR UI ─────────────────────────────────────────────────
        const CLASS_KEY = 'tb_class_filter';
        let activeClasses = new Set(Store.get(CLASS_KEY, []));

        const CLASS_DEFS = {
            'RC':  { label: 'Rice',       color: '#38bdf8' },
            'HYB': { label: 'Hybrid',     color: '#c084fc' },
            'LN':  { label: 'Long Note',  color: '#fb923c' },
            'F:S': { label: 'Farm S',     color: '#ffd700' },
            'F:A': { label: 'Farm A',     color: '#c0c0c0' },
            'F:B': { label: 'Farm B',     color: '#cd7f32' },
            'F:C': { label: 'Farm C',     color: 'rgba(255,255,255,0.35)' },
            'F:D': { label: 'Farm D',     color: '#ff6b6b' },
        };

        GM_addStyle(`
            .tb-class-panel {
                position: fixed; top: 80px; right: 20px; z-index: 99998;
                background: var(--tb-bg0); border: 1px solid var(--tb-border);
                border-radius: var(--tb-radius); padding: 0;
                box-shadow: 0 8px 24px rgba(0,0,0,0.8);
                backdrop-filter: blur(4px); min-width: 180px;
                font-family: var(--tb-font);
                animation: tb-fadeIn 0.2s ease-out;
            }
            .tb-class-header {
                padding: 8px 12px; background: rgba(26,26,26,0.8);
                border-bottom: 1px solid var(--tb-border);
                font-size: 11px; font-weight: 600; color: var(--tb-text);
                display: flex; justify-content: space-between; align-items: center;
                border-radius: var(--tb-radius) var(--tb-radius) 0 0;
            }
            .tb-class-clear {
                font-size: 10px; color: var(--tb-text-dimmer); cursor: pointer;
                background: none; border: none; font-family: var(--tb-font);
                padding: 2px 6px; border-radius: 3px; transition: all 0.15s;
            }
            .tb-class-clear:hover { color: var(--tb-text); background: rgba(255,255,255,0.08); }
            .tb-class-list { padding: 6px; display: flex; flex-direction: column; gap: 2px; }
            .tb-class-chip {
                display: flex; align-items: center; gap: 7px;
                padding: 5px 8px; border-radius: 4px; cursor: pointer;
                border: 1px solid transparent;
                transition: all 0.15s; user-select: none;
                font-size: 11px; color: var(--tb-text-dim);
            }
            .tb-class-chip:hover { background: rgba(255,255,255,0.06); color: var(--tb-text); }
            .tb-class-chip.active { background: rgba(255,255,255,0.07); border-color: var(--tb-border-hi); color: var(--tb-text); }
            .tb-class-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; opacity: 0.4; transition: all 0.15s; }
            .tb-class-chip.active .tb-class-dot { opacity: 1; }
            .tb-class-divider { height: 1px; background: var(--tb-border); margin: 3px 0; }
            .beatmapset-panel.tb-dimmed {
                opacity: 0.15 !important;
                filter: grayscale(0.7) !important;
                transition: opacity 0.15s, filter 0.15s !important;
            }
            .beatmapset-panel.tb-dimmed:hover {
                opacity: 0.35 !important;
                filter: grayscale(0.3) !important;
            }
        `);

        function buildClassPanel() {
            if (document.querySelector('.tb-class-panel')) return;
            const panel = document.createElement('div');
            panel.className = 'tb-class-panel';
            panel.innerHTML = `
                <div class="tb-class-header">
                    <span>Map Type</span>
                    <button type="button" class="tb-class-clear">Clear</button>
                </div>
                <div class="tb-class-list">
                    ${Object.entries(CLASS_DEFS).map(([key, def]) => `
                        <div class="tb-class-chip ${activeClasses.has(key) ? 'active' : ''}" data-class="${key}">
                            <div class="tb-class-dot" style="background:${def.color};opacity:${activeClasses.has(key)?'1':'0.4'}"></div>
                            <span>${def.label}</span>
                        </div>
                        ${key === 'LN' ? '<div class="tb-class-divider"></div>' : ''}
                    `).join('')}
                </div>
            `;
            document.body.appendChild(panel);

            panel.querySelector('.tb-class-clear').addEventListener('click', () => {
                activeClasses.clear();
                Store.set(CLASS_KEY, []);
                panel.querySelectorAll('.tb-class-chip').forEach(c => {
                    c.classList.remove('active');
                    c.querySelector('.tb-class-dot').style.opacity = '0.4';
                });
                applyClassFilter();
            });

            panel.querySelectorAll('.tb-class-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    const key = chip.dataset.class;
                    const dot = chip.querySelector('.tb-class-dot');
                    if (activeClasses.has(key)) {
                        activeClasses.delete(key);
                        chip.classList.remove('active');
                        dot.style.opacity = '0.4';
                    } else {
                        activeClasses.add(key);
                        chip.classList.add('active');
                        dot.style.opacity = '1';
                    }
                    Store.set(CLASS_KEY, [...activeClasses]);
                    applyClassFilter();
                });
            });
        }

        function getCardClasses(card) {
            const tags = new Set();
            card.querySelectorAll('[data-tb-injected]').forEach(el => {
                const txt = el.textContent.trim();
                if (/\bRC\b/.test(txt))  tags.add('RC');
                if (/\bHYB\b/.test(txt)) tags.add('HYB');
                if (/\bLN\b/.test(txt))  tags.add('LN');
                const fm = txt.match(/F[:\s]+([SABCD])\d*/);
                if (fm) tags.add(`F:${fm[1]}`);
            });
            return tags;
        }

        function applyClassFilter() {
            document.querySelectorAll('.beatmapset-panel').forEach(card => {
                if (activeClasses.size === 0) {
                    card.classList.remove('tb-dimmed');
                    return;
                }
                if (!card.querySelector('[data-tb-injected]')) {
                    card.classList.remove('tb-dimmed');
                    return;
                }
                const cardClasses = getCardClasses(card);
                // ALL active classes must match (AND logic within groups, OR across groups)
                const rcLnGroup   = ['RC','HYB','LN'].filter(c => activeClasses.has(c));
                const farmGroup   = ['F:S','F:A','F:B','F:C','F:D'].filter(c => activeClasses.has(c));
                const rcLnMatch   = rcLnGroup.length === 0  || rcLnGroup.some(c => cardClasses.has(c));
                const farmMatch   = farmGroup.length === 0  || farmGroup.some(c => cardClasses.has(c));
                card.classList.toggle('tb-dimmed', !(rcLnMatch && farmMatch));
            });
        }

        function injectStatsAndFilter(card, bs) {
            injectStats(card, bs);
            applyClassFilter();
        }

        function maybeShowClassPanel() {
            // floating side panel removed — inline filter handles everything
            document.querySelector('.tb-class-panel')?.remove();
        }

        function buildInlineClassFilter() {
            if (document.querySelector('.tb-inline-filter')) return;
            const grid = document.querySelector('.beatmapsets-search__filter-grid');
            if (!grid) return;

            // find the General section (first filter group) and insert after it
            const generalSection = grid.querySelector('.beatmapsets-search-filter');
            if (!generalSection) return;

            const wrap = document.createElement('div');
            wrap.className = 'beatmapsets-search-filter beatmapsets-search-filter--grid tb-inline-filter';
            wrap.innerHTML = `
                <span class="beatmapsets-search-filter__header">Map Type</span>
                <div class="beatmapsets-search-filter__items tb-inline-filter__items">
                    ${Object.entries(CLASS_DEFS).map(([key, def]) => `
                        <a class="beatmapsets-search-filter__item tb-inline-chip ${activeClasses.has(key) ? 'beatmapsets-search-filter__item--active' : ''}"
                           data-class="${key}"
                           href="#">
                            ${def.label}
                        </a>
                    `).join('')}
                </div>
            `;

            // insert right after the General section
            generalSection.insertAdjacentElement('afterend', wrap);

            wrap.querySelectorAll('.tb-inline-chip').forEach(chip => {
                chip.addEventListener('click', e => {
                    e.preventDefault();
                    const key = chip.dataset.class;
                    if (activeClasses.has(key)) {
                        activeClasses.delete(key);
                        chip.classList.remove('beatmapsets-search-filter__item--active');
                    } else {
                        activeClasses.add(key);
                        chip.classList.add('beatmapsets-search-filter__item--active');
                    }
                    Store.set(CLASS_KEY, [...activeClasses]);
                    applyClassFilter();
                    // keep floating panel in sync
                    document.querySelectorAll(`.tb-class-chip[data-class="${key}"]`).forEach(c => {
                        c.classList.toggle('active', activeClasses.has(key));
                        c.querySelector('.tb-class-dot').style.opacity = activeClasses.has(key) ? '1' : '0.4';
                    });
                });
            });
        }

        // Observe DOM — immediately re-inject from cache on any card appearing
        let scanTimer = null;
        const bmObs = new MutationObserver((muts) => {
            let hasNewCards = false;
            for (const mut of muts) {
                for (const node of mut.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    const cards = node.matches?.('.beatmapset-panel')
                        ? [node]
                        : [...(node.querySelectorAll?.('.beatmapset-panel') || [])];
                    for (const card of cards) {
                        const id = getCardId(card);
                        if (!id) continue;
                        const cached = bsCache.get(id) || (() => {
                            const s = Store.getBeatmapCache(`bs_${id}`);
                            if (s) { bsCache.set(id, s); return s; }
                        })();
                        if (cached) {
                            // re-inject immediately — no timeout, no queue
                            card.setAttribute(ATTR_DONE, id);
                            injectStats(card, cached);
                            applyClassFilter();
                        } else {
                            hasNewCards = true;
                        }
                    }
                }
            }
            if (hasNewCards) {
                clearTimeout(scanTimer);
                scanTimer = setTimeout(scanCards, 150);
            }
        });
        bmObs.observe(document.body, { childList: true, subtree: true });

        // Also scan on SPA route changes (osu! is a React SPA)
        function onNavigate() {
            pending.clear();
            queue.length = 0;
            draining = false;
            document.querySelectorAll(`[${ATTR_DONE}]`).forEach(el => el.removeAttribute(ATTR_DONE));
            document.querySelectorAll('[data-tb-injected]').forEach(el => el.remove());
            document.querySelectorAll('.tb-stats-row').forEach(el => el.remove());
            document.querySelectorAll('.tb-card-overlay').forEach(el => el.remove());
            document.querySelectorAll('.tb-spike-icon').forEach(el => el.remove());
            document.querySelectorAll('.tb-spike-dot-hi').forEach(el => el.classList.remove('tb-spike-dot-hi'));
            setTimeout(scanCards, 400);
            setTimeout(scanCards, 900);
        }
        ['pushState', 'replaceState'].forEach(method => {
            const orig = history[method];
            history[method] = (...args) => { orig.apply(history, args); onNavigate(); };
        });
        window.addEventListener('popstate', onNavigate);

        // Multiple initial scans to handle slow React hydration
        setTimeout(scanCards, 400);
        setTimeout(scanCards, 900);
        setTimeout(scanCards, 1800);
        setTimeout(scanCards, 3500);
        setTimeout(scanCards, 6000);
        setInterval(() => {
            document.querySelectorAll('.beatmapset-panel').forEach(card => {
                const id = getCardId(card);
                if (!id) return;
                if (card.querySelector('[data-tb-injected]')) return;
                if (card.hasAttribute('data-tb-failed')) return;
                if (pending.has(id)) return;
                card.removeAttribute(ATTR_DONE);
            });
            scanCards();
        }, 2000);

        // Class filter panel
        function maybeShowBoth() {
            document.querySelector('.tb-inline-filter')?.remove();
            buildInlineClassFilter();
        }
        setTimeout(maybeShowBoth, 800);
        setTimeout(maybeShowBoth, 2000);
        window.addEventListener('popstate', () => setTimeout(maybeShowBoth, 800));
        ['pushState','replaceState'].forEach(m => {
            const o = history[m]; history[m] = (...a) => { o.apply(history,a); setTimeout(maybeShowBoth, 800); };
        });

        // ── DRAG SELECT & BULK DOWNLOAD ───────────────────────────────────────
        const selectedCards = new Set(); // stores beatmapset IDs
        let isDragging     = false;
        let dragStartX     = 0;
        let dragStartY     = 0;
        let dragMoved      = false;
        let isDownloading  = false;

        // Build persistent UI elements
        const dragOverlay = document.createElement('div');
        dragOverlay.className = 'tb-drag-overlay';
        document.body.appendChild(dragOverlay);

        const bulkBar = document.createElement('div');
        bulkBar.className = 'tb-bulk-bar hidden';
        bulkBar.innerHTML = `
            <span class="tb-bulk-count">0</span>
            <span class="tb-bulk-label">maps selected</span>
            <div class="tb-bulk-sep"></div>
            <button type="button" class="tb-bulk-btn tb-bulk-btn--dl">⬇ Download All</button>
            <button type="button" class="tb-bulk-btn tb-bulk-btn--clear">✕ Clear</button>
        `;
        document.body.appendChild(bulkBar);

        const bulkCount  = bulkBar.querySelector('.tb-bulk-count');
        const dlBtn      = bulkBar.querySelector('.tb-bulk-btn--dl');
        const clearBtn   = bulkBar.querySelector('.tb-bulk-btn--clear');

        function updateBulkBar() {
            if (selectedCards.size === 0) {
                bulkBar.classList.add('hidden');
            } else {
                bulkBar.classList.remove('hidden');
                bulkCount.textContent = selectedCards.size;
            }
        }

        function getCardSetId(card) {
            const link = card.querySelector('a[href*="/beatmapsets/"]');
            if (link) { const m = link.href.match(/\/beatmapsets\/(\d+)/); if (m) return m[1]; }
            for (const a of card.querySelectorAll('a[href]')) {
                const m = a.href.match(/\/beatmapsets\/(\d+)/); if (m) return m[1];
            }
            return null;
        }

        function selectCard(card) {
            const id = getCardSetId(card);
            if (!id) return;
            selectedCards.add(id);
            card.classList.add('tb-selected');
        }

        function deselectCard(card) {
            const id = getCardSetId(card);
            if (!id) return;
            selectedCards.delete(id);
            card.classList.remove('tb-selected');
        }

        function toggleCard(card) {
            const id = getCardSetId(card);
            if (!id) return;
            if (selectedCards.has(id)) deselectCard(card);
            else selectCard(card);
            updateBulkBar();
        }

        function clearSelection() {
            document.querySelectorAll('.beatmapset-panel.tb-selected').forEach(c => c.classList.remove('tb-selected'));
            selectedCards.clear();
            updateBulkBar();
        }

        // Rect intersection test
        function rectsOverlap(r1, r2) {
            return !(r2.left > r1.right || r2.right < r1.left || r2.top > r1.bottom || r2.bottom < r1.top);
        }

        // Middle click drag to box-select
        document.addEventListener('mousedown', e => {
    if (e.button !== 1) return;
    if (e.target.closest('.tb-bulk-bar, .tb-class-panel, .tb-af-container, .tb-gif-panel')) return;

    const card = e.target.closest('.beatmapset-panel');
    if (!card) return;

    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragMoved  = false;
    isDragging = true;

    dragOverlay.style.left   = dragStartX + 'px';
    dragOverlay.style.top    = dragStartY + 'px';
    dragOverlay.style.width  = '0px';
    dragOverlay.style.height = '0px';
});

        document.addEventListener('mousemove', e => {
            if (!isDragging) return;

            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;

            if (!dragMoved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
            dragMoved = true;

            dragOverlay.classList.add('active');

            const x = Math.min(e.clientX, dragStartX);
            const y = Math.min(e.clientY, dragStartY);
            const w = Math.abs(dx);
            const h = Math.abs(dy);

            dragOverlay.style.left   = x + 'px';
            dragOverlay.style.top    = y + 'px';
            dragOverlay.style.width  = w + 'px';
            dragOverlay.style.height = h + 'px';

            const dragRect = { left: x, top: y, right: x + w, bottom: y + h };
            const allCards = [...document.querySelectorAll('.beatmapset-panel')];

            // find first and last card (by DOM order) that visibly intersects the drag box
            let firstIdx = -1, lastIdx = -1;
            allCards.forEach((card, i) => {
                const r = card.getBoundingClientRect();
                if (rectsOverlap(dragRect, { left: r.left, top: r.top, right: r.right, bottom: r.bottom })) {
                    if (firstIdx === -1) firstIdx = i;
                    lastIdx = i;
                }
            });

            // select every card between first and last in DOM order (covers scrolled-away cards)
            if (firstIdx !== -1) {
                allCards.forEach((card, i) => {
                    if (i >= firstIdx && i <= lastIdx) selectCard(card);
                });
            }

            updateBulkBar();
        });

        document.addEventListener('mouseup', e => {
            if (e.button !== 1) return;
            if (!isDragging) return;
            isDragging = false;
            dragOverlay.classList.remove('active');
            if (dragMoved) updateBulkBar();
        });

        // Prevent middle-click scroll cursor appearing
        document.addEventListener('auxclick', e => {
    if (e.button !== 1) return;
    const card = e.target.closest('.beatmapset-panel');
    if (!card) return;
    if (dragMoved) {
        e.preventDefault();
        e.stopPropagation();
    }
});

        // Bulk download
        async function bulkDownload() {
            if (isDownloading || selectedCards.size === 0) return;
            isDownloading = true;
            dlBtn.classList.add('downloading');

            const ids = [...selectedCards];
            let i = 0;

            for (const id of ids) {
                dlBtn.textContent = `⬇ ${i + 1} / ${ids.length}`;

                // Direct osu! download — opens .osz in client via file association
                const link = document.createElement('a');
                link.href = `https://osu.ppy.sh/beatmapsets/${id}/download`;
                link.setAttribute('download', `${id}.osz`);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                i++;
                // Stagger downloads so client doesn't get overwhelmed
                await sleep(1500);
            }

            dlBtn.textContent = '✓ Done!';
            dlBtn.classList.remove('downloading');
            await sleep(2000);
            dlBtn.textContent = '⬇ Download All';
            isDownloading = false;
        }

        dlBtn.addEventListener('click', bulkDownload);
        clearBtn.addEventListener('click', clearSelection);

        // Clear selection on navigation
        ['pushState','replaceState'].forEach(m => {
            const o = history[m]; history[m] = (...a) => { o.apply(history,a); clearSelection(); };
        });
        window.addEventListener('popstate', clearSelection);
    }


    // ═══════════════════════════════════════════════════════════════════════════
    //  MODULE 2 — GIF FAVORITES  (osu.ppy.sh)
    // ═══════════════════════════════════════════════════════════════════════════
    if (location.hostname === 'osu.ppy.sh' || location.hostname === 'new.ppy.sh') {

        const FAV_KEY     = 'osu_fav_list';
        const UNFAV_KEY   = 'osu_unfav_recent';
        const LAST_PROV   = 'gif_last_provider';

        function loadLS(key, def) {
            try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
        }
        function saveLS(key, val) {
            try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
        }

        const GifProviders = {
            tenor: {
                name: 'Tenor',
                getKey:   () => Store.getTenorKey(),
                setKey:   (v) => Store.setTenorKey(v),
                clearKey: () => GM_deleteValue('tenor_api_key'),
                hasKey:   () => !!Store.getTenorKey(),
                async test(k) {
                    const r = await gmXhr(`https://tenor.googleapis.com/v2/search?key=${encodeURIComponent(k)}&q=test&limit=1`);
                    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
                },
                async search(q, k) {
                    const r = await gmXhr(`https://tenor.googleapis.com/v2/search?key=${encodeURIComponent(k)}&q=${encodeURIComponent(q)}&limit=30&media_filter=gif&contentfilter=medium`);
                    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
                    const data = JSON.parse(r.responseText);
                    return (data.results||[]).map(g => ({
                        preview: g.media_formats?.nanogif?.url || g.media_formats?.tinygif?.url || g.media_formats?.gif?.url,
                        full:    g.media_formats?.mediumgif?.url || g.media_formats?.gif?.url,
                        title:   g.content_description || 'GIF',
                    })).filter(g => g.preview && g.full);
                },
            },
            giphy: {
                name: 'Giphy',
                getKey:   () => Store.getGiphyKey(),
                setKey:   (v) => Store.setGiphyKey(v),
                clearKey: () => GM_deleteValue('giphy_api_key'),
                hasKey:   () => !!Store.getGiphyKey(),
                async test(k) {
                    const r = await gmXhr(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(k)}&q=test&limit=1&rating=g`);
                    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
                },
                async search(q, k) {
                    const r = await gmXhr(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(k)}&q=${encodeURIComponent(q)}&limit=30&rating=g&lang=en`);
                    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
                    const data = JSON.parse(r.responseText);
                    return (data.data||[]).map(g => ({
                        preview: g.images?.fixed_height_small?.url || g.images?.downsized?.url,
                        full:    g.images?.downsized?.url || g.images?.original?.url,
                        title:   g.title || 'GIF',
                    })).filter(g => g.preview && g.full);
                },
            },
        };

        class GifManager {
            constructor() {
                this.favs           = loadLS(FAV_KEY, []);
                this.recentUnfavs   = loadLS(UNFAV_KEY, []);
                this.activeProvider = GM_getValue(LAST_PROV, 'tenor');
                this.searchCache    = new Map();
                this.searchTimer    = null;
                this.dropdowns      = new Set();
                this.processedEditors = new WeakSet();
                this._cleanUnfavs();
                setInterval(() => { this._cleanUnfavs(); this._syncDropdowns(); }, 60000);
            }
            _cleanUnfavs() {
                const cut = Date.now() - 30 * 60 * 1000;
                this.recentUnfavs = this.recentUnfavs.filter(u => u.unfavd > cut);
                saveLS(UNFAV_KEY, this.recentUnfavs);
            }
            saveFavs()      { saveLS(FAV_KEY, this.favs); }
            saveUnfavs()    { saveLS(UNFAV_KEY, this.recentUnfavs); }
            addFav(url, title='') {
                if (this.favs.find(f => f.url === url)) return false;
                this.favs.push({ id: Date.now() + Math.random(), url, title, addedAt: new Date().toISOString() });
                this.saveFavs(); return true;
            }
            removeFav(id) {
                const f = this.favs.find(f => f.id === id);
                if (f) { this.recentUnfavs.push({ ...f, unfavd: Date.now() }); this.saveUnfavs(); }
                this.favs = this.favs.filter(f => f.id !== id);
                this.saveFavs();
            }
            refav(url) {
                const r = this.recentUnfavs.find(u => u.url === url);
                if (!r) return false;
                this.recentUnfavs = this.recentUnfavs.filter(u => u.url !== url);
                this.saveUnfavs();
                this.favs.push({ ...r, id: Date.now() + Math.random(), addedAt: new Date().toISOString() });
                this.saveFavs(); return true;
            }
            async search(q) {
                const p = GifProviders[this.activeProvider];
                if (!p?.hasKey()) return null;
                const ck = `${this.activeProvider}:${q}`;
                if (this.searchCache.has(ck)) return this.searchCache.get(ck);
                const res = await p.search(q, p.getKey());
                this.searchCache.set(ck, res); return res;
            }
            exportFavs() {
                const blob = new Blob([JSON.stringify({ version:'1.0', exported: new Date().toISOString(), favorites: this.favs }, null, 2)], { type: 'application/json' });
                const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `osu-favs-${Date.now()}.json` });
                a.click(); URL.revokeObjectURL(a.href);
            }
            importFavs(file) {
                const fr = new FileReader();
                fr.onload = e => {
                    try {
                        const d = JSON.parse(e.target.result);
                        const existing = new Set(this.favs.map(f => f.url));
                        const added = (d.favorites||[]).filter(f => f.url && !existing.has(f.url));
                        this.favs.push(...added.map(f => ({ ...f, id: Date.now() + Math.random() })));
                        this.saveFavs(); this._syncDropdowns();
                        alert(`Imported ${added.length} new favorites!`);
                    } catch { alert('Invalid favorites file!'); }
                };
                fr.readAsText(file);
            }
            _syncDropdowns() { this.dropdowns.forEach(d => d.renderFavTab()); }
            register(d)   { this.dropdowns.add(d); }
            unregister(d) { this.dropdowns.delete(d); }

            init() {
                this._scan();
                new MutationObserver(() => {
                    setTimeout(() => this._scan(), 120);
                }).observe(document.body, { childList: true, subtree: true });
                ['pushState','replaceState'].forEach(method => {
                    const orig = history[method];
                    history[method] = (...args) => { orig.apply(history, args); setTimeout(() => this._scan(), 600); };
                });
                window.addEventListener('popstate', () => setTimeout(() => this._scan(), 600));
            }
            _scan() {
                document.querySelectorAll('.comment-editor').forEach(ed => {
                    if (this.processedEditors.has(ed)) return;
                    this.processedEditors.add(ed);
                    this._inject(ed);
                });
            }
            _inject(editor) {
                const footer = editor.querySelector('.comment-editor__footer');
                if (!footer) return;
                const wrap = document.createElement('div');
                wrap.className = 'comment-editor__footer-item';
                wrap.style.position = 'relative';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn-osu-big btn-osu-big--comment-editor tb-gif-button';
                btn.title = 'GIF Favorites';
                btn.innerHTML = `<span class="btn-osu-big__content btn-osu-big__content--center"><span class="btn-osu-big__left"><span class="btn-osu-big__text-top"><span class="fa fa-fw"><span class="fas fa-heart"></span></span></span></span></span>`;
                wrap.appendChild(btn);
                const dropdown = new GifDropdown(this, editor);
                wrap.appendChild(dropdown.el);
                const items = footer.querySelectorAll('.comment-editor__footer-item');
                const last  = items[items.length - 1];
                if (last) footer.insertBefore(wrap, last); else footer.appendChild(wrap);
                btn.addEventListener('click', e => {
                    e.stopPropagation(); e.preventDefault();
                    document.querySelectorAll('.tb-gif-panel.open').forEach(p => { if (p !== dropdown.el) p.classList.remove('open'); });
                    dropdown.el.classList.toggle('open');
                });
                document.addEventListener('click', () => dropdown.el.classList.remove('open'));
            }
        }

        class GifDropdown {
            constructor(mgr, editor) {
                this.mgr    = mgr;
                this.editor = editor;
                this.el     = this._build();
                mgr.register(this);
            }
            get textarea() { return this.editor.querySelector('.comment-editor__message'); }

            _build() {
                const el = document.createElement('div');
                el.className = 'tb-gif-panel';
                el.innerHTML = `
                    <div class="tb-gif-header">
                        <div class="tb-gif-title">GIF Favorites</div>
                        <div class="tb-gif-hbtns">
                            <button type="button" class="tb-gif-hbtn js-import" title="Import favorites">Import</button>
                            <button type="button" class="tb-gif-hbtn js-export" title="Export favorites">Export</button>
                        </div>
                    </div>
                    <div class="tb-gif-tabs">
                        <button type="button" class="tb-gif-tab active" data-tab="search">Search</button>
                        <button type="button" class="tb-gif-tab" data-tab="favs">Faves</button>
                        <button type="button" class="tb-gif-tab" data-tab="add">Add URL</button>
                        <button type="button" class="tb-gif-tab" data-tab="keys">API Keys</button>
                    </div>

                    <!-- Search -->
                    <div class="tb-gif-body active" data-tab="search">
                        <div class="tb-gif-provbar">
                            Source:
                            <button type="button" class="tb-gif-prov ${this.mgr.activeProvider==='tenor'?'active':''}" data-prov="tenor">Tenor</button>
                            <button type="button" class="tb-gif-prov ${this.mgr.activeProvider==='giphy'?'active':''}" data-prov="giphy">Giphy</button>
                        </div>
                        <div class="tb-gif-searchbar">
                            <input type="text" class="tb-input" placeholder="SEARCH GIFS…" autocomplete="off">
                        </div>
                        <div class="tb-gif-grid js-search-grid">
                            <div class="tb-gif-empty">Search for GIFs above</div>
                        </div>
                    </div>

                    <!-- Favs -->
                    <div class="tb-gif-body" data-tab="favs">
                        <div class="tb-remind">⚠ Export your favorites regularly — they are stored locally.</div>
                        <div class="tb-gif-grid js-fav-grid"></div>
                    </div>

                    <!-- Add URL -->
                    <div class="tb-gif-body" data-tab="add">
                        <div class="tb-gif-addsec">
                            <input type="text" class="tb-input" placeholder="PASTE IMAGE / GIF URL…" autocomplete="off">
                            <div class="tb-gif-hint">s-ul.eu · imgur · catbox.moe · Discord CDN all work</div>
                            <button type="button" class="tb-btn js-add-btn">Add to Favorites</button>
                        </div>
                        <div class="tb-gif-preview js-preview">
                            <img class="js-prev-img" alt="Preview" style="display:none">
                            <div class="tb-gif-prevurl js-prev-url"></div>
                        </div>
                    </div>

                    <!-- API Keys -->
                    <div class="tb-gif-body" data-tab="keys">
                        <div class="tb-gif-settings">${this._keysHTML()}</div>
                    </div>
                `;
                this._events(el);
                this.renderFavTab(el);
                return el;
            }

            _keysHTML() {
    const osuBlock = `
    <div class="tb-key-group">
        <div class="tb-key-label">Review Token</div>
        <input class="tb-key-input" type="password" placeholder="Paste your REVIEW_TOKEN…" id="tb-review-token" value="${Store.getReviewToken()}" autocomplete="off">
        <div class="tb-key-actions">
            <button type="button" class="tb-key-save" id="tb-review-token-save">Save</button>
        </div>
        <div class="tb-key-desc">Must match the REVIEW_TOKEN used to start the server.</div>
    </div>
    <div class="tb-divider"></div>
    <div class="tb-key-group">
        <div class="tb-key-label">
            Review Server URL
            <span class="tb-key-badge ok">localhost</span>
        </div>
        <input class="tb-key-input" type="text" placeholder="http://localhost:3000" id="tb-review-server-url" value="${Store.get('review_server_url','http://localhost:3000')}" autocomplete="off">
        <div class="tb-key-actions">
            <button type="button" class="tb-key-save" id="tb-review-server-save">Save</button>
        </div>
        <div class="tb-key-desc">URL of your local review server. Leave as localhost if running on the same machine.</div>
    </div>
    <div class="tb-divider"></div>
    <div class="tb-key-group">
        <div class="tb-key-label">
            osu! Client ID
            <span class="tb-key-badge ${Store.getOsuClientId()?'ok':'warn'}" data-badge="osu_id">${Store.getOsuClientId()?'✓ Saved':'Not set'}</span>
        </div>
        <input class="tb-key-input" type="text" placeholder="Client ID (number)…" id="tb-osu-client-id" value="${Store.getOsuClientId()}" autocomplete="off">
        <div class="tb-key-group">
            <div class="tb-key-label">osu! Client Secret</div>
            <input class="tb-key-input" type="password" placeholder="Client Secret…" id="tb-osu-client-secret" value="${Store.getOsuClientSecret()}" autocomplete="off">
        </div>
        <div class="tb-key-actions">
            <button type="button" class="tb-key-save" id="tb-osu-save">Save</button>
            <button type="button" class="tb-key-clear" id="tb-osu-clear">Clear</button>
        </div>
        <div class="tb-key-desc">Create an OAuth app at <a href="https://osu.ppy.sh/home/account/edit#oauth" target="_blank">osu! account settings</a> — set Application Callback URL to <code>http://localhost</code>. Also set your username below for "played before" tracking.</div>
        <input class="tb-key-input" type="text" placeholder="Your osu! username…" id="tb-osu-username" value="${Store.getUsername()}" autocomplete="off" style="margin-top:6px">
        <div class="tb-key-msg" id="tb-osu-msg"></div>
    </div>
    <div class="tb-divider"></div>
    `;
    return osuBlock + Object.entries(GifProviders).map(([id, p]) => `
        <div class="tb-key-group">
            <div class="tb-key-label">
                ${p.name} API Key
                <span class="tb-key-badge ${p.hasKey()?'ok':'warn'}" data-badge="${id}">${p.hasKey()?'✓ Saved':'Not set'}</span>
            </div>
            <input class="tb-key-input" type="password" placeholder="Paste ${p.name} key…" data-provider="${id}" value="${p.getKey()}" autocomplete="off">
            <div class="tb-key-actions">
                <button type="button" class="tb-key-save" data-save="${id}">Save &amp; Test</button>
                <button type="button" class="tb-key-clear" data-clear="${id}">Clear</button>
            </div>
            <div class="tb-key-desc">${id==='tenor'
                ? `Free key from <a href="https://console.cloud.google.com/" target="_blank">Google Cloud Console</a> — enable Tenor API then create a Credentials key.`
                : `Free key from <a href="https://developers.giphy.com/" target="_blank">developers.giphy.com</a> — create an app (API type).`
            }</div>
            <div class="tb-key-msg" data-msg="${id}"></div>
        </div>
        <div class="tb-divider"></div>
    `).join('');
}

            _events(el) {
                el.addEventListener('keydown', e => e.stopPropagation());
                el.addEventListener('click',   e => e.stopPropagation());

                el.querySelectorAll('.tb-gif-tab').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const tab = btn.dataset.tab;
                        el.querySelectorAll('.tb-gif-tab').forEach(b => b.classList.toggle('active', b === btn));
                        el.querySelectorAll('.tb-gif-body').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
                        if (tab === 'favs') this.renderFavTab(el);
                    });
                });

                el.querySelectorAll('.tb-gif-prov').forEach(btn => {
                    btn.addEventListener('click', () => {
                        this.mgr.activeProvider = btn.dataset.prov;
                        GM_setValue(LAST_PROV, btn.dataset.prov);
                        this.mgr.searchCache.clear();
                        el.querySelectorAll('.tb-gif-prov').forEach(b => b.classList.toggle('active', b === btn));
                        const q = el.querySelector('[data-tab="search"] .tb-input').value.trim();
                        if (q.length > 1) this._doSearch(q, el);
                    });
                });

                const searchInput = el.querySelector('[data-tab="search"] .tb-input');
                const searchGrid  = el.querySelector('.js-search-grid');
                searchInput.addEventListener('input', () => {
                    clearTimeout(this.mgr.searchTimer);
                    const q = searchInput.value.trim();
                    if (q.length < 2) { searchGrid.innerHTML = '<div class="tb-gif-empty">Search for GIFs above</div>'; return; }
                    searchGrid.innerHTML = `<div class="tb-gif-loading"><span class="tb-spinner"></span>Searching…</div>`;
                    this.mgr.searchTimer = setTimeout(() => this._doSearch(q, el), 350);
                });

                el.querySelector('.js-import').addEventListener('click', () => {
                    const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' });
                    inp.onchange = e => { if (e.target.files[0]) this.mgr.importFavs(e.target.files[0]); };
                    inp.click();
                });
                el.querySelector('.js-export').addEventListener('click', () => this.mgr.exportFavs());

                const addInput   = el.querySelector('[data-tab="add"] .tb-input');
                const preview    = el.querySelector('.js-preview');
                const prevImg    = el.querySelector('.js-prev-img');
                const prevUrl    = el.querySelector('.js-prev-url');
                let prevTimer;
                el.querySelector('.js-add-btn').addEventListener('click', () => {
                    const url = addInput.value.trim();
                    if (!url) return;
                    if (this.mgr.addFav(url)) { addInput.value = ''; preview.classList.remove('show'); this.mgr._syncDropdowns(); }
                    else alert('Already in favorites!');
                });
                addInput.addEventListener('input', () => {
                    clearTimeout(prevTimer);
                    const url = addInput.value.trim();
                    if (!url) { preview.classList.remove('show'); return; }
                    prevTimer = setTimeout(() => {
                        prevImg.src = url; prevImg.style.display = 'block';
                        prevUrl.textContent = url; preview.classList.add('show');
                        prevImg.onerror = () => { prevImg.style.display = 'none'; prevUrl.textContent = url + ' (preview unavailable)'; };
                    }, 500);
                });

                el.querySelectorAll('[data-save]').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const id = btn.dataset.save, p = GifProviders[id];
                        const inp = el.querySelector(`input[data-provider="${id}"]`);
                        const msg = el.querySelector(`[data-msg="${id}"]`);
                        const badge = el.querySelector(`[data-badge="${id}"]`);
                        const k = inp.value.trim();
                        if (!k) { msg.textContent = 'Please enter a key.'; msg.className = 'tb-key-msg err'; return; }
                        const orig = btn.textContent; btn.textContent = 'Testing…'; btn.disabled = true;
                        try {
                            await p.test(k); p.setKey(k); this.mgr.searchCache.clear();
                            badge.textContent = '✓ Saved'; badge.className = 'tb-key-badge ok';
                            msg.textContent = '✓ Key saved and working!'; msg.className = 'tb-key-msg ok';
                        } catch(e) {
                            msg.textContent = `✗ Test failed (${e.message})`; msg.className = 'tb-key-msg err';
                        } finally { btn.textContent = orig; btn.disabled = false; }
                    });
                });
                // osu! credential buttons
                const osuSave = el.querySelector('#tb-osu-save');
                const osuClear = el.querySelector('#tb-osu-clear');
                const osuMsg  = el.querySelector('#tb-osu-msg');
el.querySelector('#tb-review-server-save')?.addEventListener('click', () => {
    const url = el.querySelector('#tb-review-server-url')?.value.trim();
    if (url) Store.set('review_server_url', url);
});
el.querySelector('#tb-review-token-save')?.addEventListener('click', () => {
    const token = el.querySelector('#tb-review-token')?.value.trim();
    if (token) Store.setReviewToken(token);
});
                if (osuSave) {
                    osuSave.addEventListener('click', () => {
                        const id  = el.querySelector('#tb-osu-client-id')?.value.trim();
                        const sec = el.querySelector('#tb-osu-client-secret')?.value.trim();
                        const usr = el.querySelector('#tb-osu-username')?.value.trim();
                        if (id)  Store.setOsuClientId(id);
                        if (sec) Store.setOsuClientSecret(sec);
                        if (usr) Store.setUsername(usr);
                        Store.setOsuToken(null); // force token refresh
                        Store.setOsuTokenExp(0);
                        Store.set('osu_user_id', null);
                        playedCache.clear();
                        if (osuMsg) { osuMsg.textContent = '✓ Saved — reload page to fetch scores'; osuMsg.className = 'tb-key-msg ok'; }
                        el.querySelector('[data-badge="osu_id"]')?.setAttribute('class','tb-key-badge ok');
                    });
                }
                if (osuClear) {
                    osuClear.addEventListener('click', () => {
                        Store.setOsuClientId(''); Store.setOsuClientSecret('');
                        Store.setOsuToken(null); Store.setOsuTokenExp(0);
                        Store.set('osu_user_id', null); playedCache.clear();
                        ['#tb-osu-client-id','#tb-osu-client-secret','#tb-osu-username'].forEach(sel => { const i = el.querySelector(sel); if(i) i.value=''; });
                        if (osuMsg) { osuMsg.textContent = 'Cleared.'; osuMsg.className = 'tb-key-msg ok'; }
                    });
                }

                el.querySelectorAll('[data-clear]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const id = btn.dataset.clear, p = GifProviders[id];
                        p.clearKey(); this.mgr.searchCache.clear();
                        const inp = el.querySelector(`input[data-provider="${id}"]`);
                        const badge = el.querySelector(`[data-badge="${id}"]`);
                        if (inp) inp.value = '';
                        if (badge) { badge.textContent = 'Not set'; badge.className = 'tb-key-badge warn'; }
                    });
                });
            }

            async _doSearch(q, el) {
                const grid = el.querySelector('.js-search-grid');
                const p = GifProviders[this.mgr.activeProvider];
                if (!p.hasKey()) {
                    grid.innerHTML = `<div class="tb-gif-empty">No ${p.name} API key set.<br><small>Go to [ API Keys ] tab.</small></div>`;
                    return;
                }
                grid.innerHTML = `<div class="tb-gif-loading"><span class="tb-spinner"></span>Searching…</div>`;
                try {
                    const results = await this.mgr.search(q);
                    this._renderSearch(results, grid);
                } catch { grid.innerHTML = `<div class="tb-gif-empty">Search error — check your API key.</div>`; }
            }

            _renderSearch(results, grid) {
                if (!results?.length) { grid.innerHTML = `<div class="tb-gif-empty">No results. Try different keywords.</div>`; return; }
                grid.innerHTML = '';
                results.forEach(gif => {
                    const card = document.createElement('div');
                    card.className = 'tb-gif-card';
                    const img = document.createElement('img');
                    img.src = gif.preview; img.alt = gif.title; img.loading = 'lazy';
                    card.appendChild(img);
                    const favBtn = document.createElement('button');
                    favBtn.type = 'button'; favBtn.className = 'tb-gif-card-fav'; favBtn.title = 'Add to favorites';
                    favBtn.innerHTML = '<span class="fas fa-heart"></span>';
                    card.appendChild(favBtn);
                    card.addEventListener('click', e => { if (e.target.closest('.tb-gif-card-fav')) return; this._insert(gif.full); });
                    favBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        if (this.mgr.addFav(gif.full, gif.title)) {
                            this.mgr._syncDropdowns();
                            favBtn.innerHTML = '<span class="fas fa-check"></span>'; favBtn.style.color = 'var(--tb-green)';
                            setTimeout(() => { favBtn.innerHTML = '<span class="fas fa-heart"></span>'; favBtn.style.color = ''; }, 1200);
                        }
                    });
                    grid.appendChild(card);
                });
            }

            renderFavTab(el = this.el) {
                const grid = el?.querySelector('.js-fav-grid');
                if (!grid) return;
                const favTab = el.querySelector('[data-tab="favs"].tb-gif-tab');
                if (favTab) favTab.textContent = `Faves (${this.mgr.favs.length})`;
                const all = [
                    ...this.mgr.favs,
                    ...this.mgr.recentUnfavs.filter(u => !this.mgr.favs.find(f => f.url === u.url)),
                ];
                if (!all.length) { grid.innerHTML = `<div class="tb-gif-empty">No favorites yet.<br><small>Search for GIFs or add URLs.</small></div>`; return; }
                grid.innerHTML = '';
                all.forEach(item => {
                    const isFaved  = !!this.mgr.favs.find(f => f.url === item.url);
                    const isRecent = !!this.mgr.recentUnfavs.find(u => u.url === item.url);
                    const card = document.createElement('div');
                    card.className = `tb-fav-card${isRecent && !isFaved ? ' unfavd' : ''}`;
                    const img = document.createElement('img'); img.src = item.url; img.alt = item.title||''; img.loading = 'lazy';
                    card.appendChild(img);
                    const heart = document.createElement('span');
                    heart.className = `tb-fav-heart ${isFaved ? '' : 'off'}`;
                    heart.title = isFaved ? 'Remove from favorites' : 'Add back';
                    heart.innerHTML = '<span class="fas fa-heart"></span>';
                    card.appendChild(heart);
                    card.addEventListener('click', e => { if (e.target.closest('.tb-fav-heart')) return; this._insert(item.url); });
                    heart.addEventListener('click', e => {
                        e.stopPropagation();
                        if (isFaved) this.mgr.removeFav(item.id);
                        else         this.mgr.refav(item.url);
                        this.mgr._syncDropdowns();
                    });
                    grid.appendChild(card);
                });
            }

            async _insert(url) {
                const ta = this.textarea;
                if (!ta) return;
                const MAX_BYTES = 2 * 1024 * 1024;
                try {
                    const head = await new Promise((res, rej) => {
                        GM_xmlhttpRequest({
                            method: 'HEAD', url, timeout: 6000,
                            onload: r => res(r), onerror: () => rej(), ontimeout: () => rej(),
                        });
                    });
                    const size = parseInt(head.responseHeaders?.match(/content-length:\s*(\d+)/i)?.[1] || '0');
                    if (size > MAX_BYTES) {
                        notify(`✗ GIF too large (${(size/1024/1024).toFixed(1)} MB) — osu! limit ~2 MB`, 'error', 4000);
                        return;
                    }
                } catch { /* HEAD failed — proceed anyway */ }
                const md = `![](${url})`, pos = ta.selectionStart ?? ta.value.length;
                ta.value = ta.value.slice(0, pos) + md + ta.value.slice(pos);
                ta.focus(); ta.setSelectionRange(pos + md.length, pos + md.length);
                ['input','change'].forEach(ev => ta.dispatchEvent(new Event(ev, { bubbles: true })));
                this.el.classList.remove('open');
            }
        }

// ═══════════════════════════════════════════════════════════════════════════
//  MODULE 3 — PLAYER REVIEWS
// ═══════════════════════════════════════════════════════════════════════════
(function() {
    const REVIEW_SERVER = Store.get('review_server_url', 'https://osu-suite.onrender.com');
    const REVIEW_CSS = `
        .tb-reviews-panel {
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            z-index: 999999; width: 480px; max-height: 70vh;
            background: var(--tb-bg0); border: 1px solid var(--tb-border);
            border-radius: var(--tb-radius);
            box-shadow: 0 16px 48px rgba(0,0,0,0.9);
            backdrop-filter: blur(8px); font-family: var(--tb-font);
            display: none; flex-direction: column;
            animation: tb-fadeIn 0.2s ease-out;
        }
        .tb-reviews-panel.open { display: flex; }
        .tb-reviews-backdrop {
            position: fixed; inset: 0; z-index: 999998;
            background: rgba(0,0,0,0.5); display: none;
        }
        .tb-reviews-backdrop.open { display: block; }
        .tb-reviews-header {
            padding: 12px 16px; background: rgba(26,26,26,0.9);
            border-bottom: 1px solid var(--tb-border);
            display: flex; justify-content: space-between; align-items: center;
            border-radius: var(--tb-radius) var(--tb-radius) 0 0;
            flex-shrink: 0;
        }
        .tb-reviews-title {
            font-size: 13px; font-weight: 600; color: var(--tb-text);
            display: flex; align-items: center; gap: 8px;
        }
        .tb-reviews-title-count {
            font-size: 10px; padding: 2px 7px; border-radius: 8px;
            background: rgba(255,255,255,0.07); color: var(--tb-text-dim);
            font-weight: 400;
        }
        .tb-reviews-close {
            background: none; border: none; color: var(--tb-text-dimmer);
            font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 4px;
            line-height: 1; transition: all 0.15s; font-family: var(--tb-font);
        }
        .tb-reviews-close:hover { color: var(--tb-text); background: rgba(255,255,255,0.08); }
        .tb-reviews-list {
            overflow-y: auto; flex: 1; padding: 8px;
            display: flex; flex-direction: column; gap: 6px;
        }
        .tb-review-card {
            background: rgba(255,255,255,0.03); border: 1px solid var(--tb-border);
            border-radius: 5px; padding: 10px 12px;
            animation: tb-fadeIn 0.15s ease-out;
        }
        .tb-review-card-top {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 6px;
        }
        .tb-review-author {
            font-size: 11px; font-weight: 600; color: var(--tb-accent2);
            text-decoration: none;
        }
        .tb-review-author:hover { text-decoration: underline; }
        .tb-review-stars {
            display: flex; gap: 2px;
        }
        .tb-review-star {
            font-size: 11px; color: rgba(255,255,255,0.15);
        }
        .tb-review-star.filled { color: #ffd93d; }
        .tb-review-body {
            font-size: 11px; color: var(--tb-text-dim); line-height: 1.6;
            word-break: break-word;
        }
        .tb-review-date {
            font-size: 9px; color: var(--tb-text-dimmer);
            margin-top: 5px; text-align: right;
        }
        .tb-reviews-empty {
            text-align: center; padding: 32px 16px;
            color: var(--tb-text-dimmer); font-size: 11px; line-height: 1.8;
        }
        .tb-reviews-write {
            border-top: 1px solid var(--tb-border); padding: 12px;
            background: rgba(0,0,0,0.2); flex-shrink: 0;
            border-radius: 0 0 var(--tb-radius) var(--tb-radius);
        }
        .tb-reviews-write-title {
            font-size: 10px; font-weight: 600; color: var(--tb-text-dim);
            margin-bottom: 8px; letter-spacing: 0.3px;
        }
        .tb-reviews-stars-pick {
            display: flex; gap: 4px; margin-bottom: 8px;
        }
        .tb-reviews-star-btn {
            background: none; border: none; font-size: 16px;
            color: rgba(255,255,255,0.15); cursor: pointer; padding: 2px;
            transition: all 0.1s; line-height: 1;
        }
        .tb-reviews-star-btn.active { color: #ffd93d; }
        .tb-reviews-star-btn:hover { transform: scale(1.2); }
        .tb-reviews-textarea {
            width: 100%; min-height: 60px; resize: vertical;
            background: rgba(0,0,0,0.5); border: 1px solid var(--tb-border);
            border-radius: 4px; color: var(--tb-text); font-size: 11px;
            font-family: var(--tb-font); padding: 7px 10px;
            box-sizing: border-box; margin-bottom: 8px; transition: border-color 0.15s;
        }
        .tb-reviews-textarea:focus { outline: none; border-color: var(--tb-border-hi); }
        .tb-reviews-textarea::placeholder { color: var(--tb-text-dimmer); }
        .tb-reviews-submit-row {
            display: flex; justify-content: space-between; align-items: center;
        }
        .tb-reviews-submit {
            padding: 6px 16px; background: rgba(107,182,255,0.12);
            border: 1px solid rgba(107,182,255,0.3); border-radius: 4px;
            color: var(--tb-accent2); font-size: 11px; font-weight: 600;
            cursor: pointer; font-family: var(--tb-font); transition: all 0.15s;
        }
        .tb-reviews-submit:hover { background: rgba(107,182,255,0.22); }
        .tb-reviews-submit:disabled { opacity: 0.4; cursor: default; }
        .tb-reviews-char {
            font-size: 10px; color: var(--tb-text-dimmer);
        }
        .tb-reviews-err {
            font-size: 10px; color: var(--tb-red); margin-top: 4px;
        }
        .tb-reviews-loading {
            text-align: center; padding: 24px; color: var(--tb-text-dim);
            font-size: 11px;
        }
    `;
    GM_addStyle(REVIEW_CSS);

    const MAX_CHARS = 300;
        const BLOCKED_WORDS = [
            // add words here — recommend pulling from a maintained list like
            // https://github.com/coffee-and-fun/google-profanity-words
        ];
        function containsSlur(text) {
            const lower = text.toLowerCase();
            return BLOCKED_WORDS.some(w => {
                const re = new RegExp(`(?<![a-z])${w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![a-z])`, 'i');
                return re.test(lower);
            });
        }
    let panel = null, backdrop = null;
    let currentUserId = null, currentUsername = null;
    let selectedStars = 0;
    let authPopup = null;

    function getServerUrl() {
        return Store.get('review_server_url', 'https://osu-suite.onrender.com').replace(/\/+$/, '');
    }

    // These must match your Render env vars exactly
    const OSU_OAUTH_CLIENT_ID = Store.getOsuClientId();
    const OSU_OAUTH_REDIRECT  = `${getServerUrl()}/auth/callback`;

    async function osuLogin() {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url: `${getServerUrl()}/auth/login`,
            timeout: 8000,
            onload: r => {
                try {
                    const { url } = JSON.parse(r.responseText);
                    if (!url) { reject(new Error('Server did not return a login URL')); return; }
                    authPopup = window.open(url, 'osu-auth', 'width=500,height=700,scrollbars=yes');
                    if (!authPopup) { reject(new Error('Popup was blocked — please allow popups for osu.ppy.sh')); return; }
                    const timeout = setTimeout(() => {
                        window.removeEventListener('message', handler);
                        reject(new Error('Login timed out — please try again'));
                    }, 120000);
                    function handler(e) {
                        if (e.data?.type === 'osu-auth-success') {
                            clearTimeout(timeout);
                            window.removeEventListener('message', handler);
                            const { token, userId, username, avatarUrl } = e.data;
                            Store.setSessionToken(token);
                            Store.setSessionUser({ userId, username, avatarUrl });
                            Store.setUsername(username);
                            resolve({ userId, username, avatarUrl });
                        } else if (e.data?.type === 'osu-auth-error') {
                            clearTimeout(timeout);
                            window.removeEventListener('message', handler);
                            reject(new Error(e.data.error || 'Auth failed'));
                        }
                    }
                    window.addEventListener('message', handler);
                } catch(e) { reject(new Error('Invalid response from server')); }
            },
            onerror: () => reject(new Error('Could not reach review server')),
            ontimeout: () => reject(new Error('Server timed out')),
        });
    });
}

    async function osuLogout() {
        const token = Store.getSessionToken();
        if (token) {
            GM_xmlhttpRequest({
                method: 'POST', url: `${getServerUrl()}/auth/logout`,
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 5000, onload: () => {}, onerror: () => {},
            });
        }
        Store.clearSession();
        Store.setUsername('');
    }

    async function verifySession() {
        const token = Store.getSessionToken();
        if (!token) return null;
        try {
            const r = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET', url: `${getServerUrl()}/auth/me`,
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 5000, onload: resolve, onerror: reject, ontimeout: reject,
                });
            });
            if (r.status === 200) {
                const user = JSON.parse(r.responseText);
                Store.setSessionUser(user);
                return user;
            }
        } catch {}
        Store.clearSession();
        return null;
    }

    function getProfileUserId() {
        // osu! stores user data in a script tag
        const el = document.querySelector('#json-user');
        if (el) { try { return JSON.parse(el.textContent)?.id; } catch {} }
        // fallback: URL
        const m = location.pathname.match(/\/users\/(\d+)/);
        return m ? parseInt(m[1]) : null;
    }

    function getProfileUsername() {
        const el = document.querySelector('#json-user');
        if (el) { try { return JSON.parse(el.textContent)?.username; } catch {} }
        return document.querySelector('.profile-info__name')?.textContent?.trim() || 'this player';
    }

    function buildPanel() {
        if (panel) return;

        backdrop = document.createElement('div');
        backdrop.className = 'tb-reviews-backdrop';
        document.body.appendChild(backdrop);

        panel = document.createElement('div');
        panel.className = 'tb-reviews-panel';
        panel.innerHTML = `
            <div class="tb-reviews-header">
                <div class="tb-reviews-title">
                    <i class="fas fa-comment-alt"></i>
                    Reviews
                    <span class="tb-reviews-title-count js-count">0</span>
                </div>
                <button type="button" class="tb-reviews-close">✕</button>
            </div>
            <div class="tb-reviews-list js-list">
                <div class="tb-reviews-loading"><span class="tb-spinner"></span> Loading reviews…</div>
            </div>
            <div class="tb-reviews-write js-write-section">
                <div class="tb-reviews-auth js-auth-prompt" style="display:none;text-align:center;padding:16px;gap:8px;flex-direction:column;align-items:center;">
                    <div style="font-size:11px;color:var(--tb-text-dim);margin-bottom:8px;">Log in with your osu! account to write a review</div>
                    <button type="button" class="tb-reviews-submit js-login-btn" style="width:100%;padding:10px;">Log in with osu!</button>
                    <div class="tb-reviews-err js-login-err" style="font-size:10px;"></div>
                </div>
                <div class="tb-reviews-form js-write-form" style="display:none;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <div class="tb-reviews-write-title">WRITE A REVIEW</div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span class="js-logged-in-as" style="font-size:10px;color:var(--tb-text-dimmer);"></span>
                            <button type="button" class="tb-reviews-close js-logout-btn" style="font-size:11px;padding:2px 8px;">Log out</button>
                        </div>
                    </div>
                    <div class="tb-reviews-stars-pick js-stars">
                        ${[1,2,3,4,5].map(i => `<button type="button" class="tb-reviews-star-btn" data-star="${i}">★</button>`).join('')}
                    </div>
                    <textarea class="tb-reviews-textarea js-ta" placeholder="Share your experience with this player… (be respectful)" maxlength="${MAX_CHARS}"></textarea>
                    <div class="tb-reviews-submit-row">
                        <button type="button" class="tb-reviews-submit js-submit" disabled>Submit</button>
                        <span class="tb-reviews-char js-char">0 / ${MAX_CHARS}</span>
                    </div>
                    <div class="tb-reviews-err js-err"></div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        function highlightStars(n) {
            panel.querySelectorAll('.tb-reviews-star-btn').forEach(b => {
                b.classList.toggle('active', +b.dataset.star <= n);
            });
        }

        function validateSubmit() {
            const ta = panel.querySelector('.js-ta');
            const ok = ta.value.trim().length >= 5 && selectedStars > 0;
            panel.querySelector('.js-submit').disabled = !ok;
        }

        function refreshAuthUI() {
            const session = Store.getSessionUser();
            const authPrompt = panel.querySelector('.js-auth-prompt');
            const writeForm  = panel.querySelector('.js-write-form');
            if (session) {
                authPrompt.style.display = 'none';
                writeForm.style.display  = 'block';
                panel.querySelector('.js-logged-in-as').textContent = `Logged in as ${session.username}`;
            } else {
                authPrompt.style.display = 'flex';
                writeForm.style.display  = 'none';
            }
        }

        // Star picker
        panel.querySelectorAll('.tb-reviews-star-btn').forEach(btn => {
            btn.addEventListener('mouseenter', () => highlightStars(+btn.dataset.star));
            btn.addEventListener('mouseleave', () => highlightStars(selectedStars));
            btn.addEventListener('click', () => {
                selectedStars = +btn.dataset.star;
                highlightStars(selectedStars);
                validateSubmit();
            });
        });

        // Textarea counter
        const ta = panel.querySelector('.js-ta');
        const charEl = panel.querySelector('.js-char');
        ta.addEventListener('input', () => {
            charEl.textContent = `${ta.value.length} / ${MAX_CHARS}`;
            validateSubmit();
        });

        // Login button
        panel.querySelector('.js-login-btn').addEventListener('click', async () => {
            const loginBtn = panel.querySelector('.js-login-btn');
            const loginErr = panel.querySelector('.js-login-err');
            loginBtn.disabled = true;
            loginBtn.textContent = 'Opening osu! login…';
            loginErr.textContent = '';
            try {
                await osuLogin();
                refreshAuthUI();
                notify('✓ Logged in!', 'success');
            } catch (e) {
                loginErr.textContent = `✗ ${e.message}`;
            } finally {
                loginBtn.disabled = false;
                loginBtn.textContent = 'Log in with osu!';
            }
        });

        // Logout button
        panel.querySelector('.js-logout-btn').addEventListener('click', async () => {
            await osuLogout();
            selectedStars = 0;
            highlightStars(0);
            if (ta) { ta.value = ''; charEl.textContent = `0 / ${MAX_CHARS}`; }
            refreshAuthUI();
        });

        // Submit
        panel.querySelector('.js-submit').addEventListener('click', async () => {
            const text  = ta.value.trim();
            const errEl = panel.querySelector('.js-err');
            errEl.textContent = '';
            if (!text || selectedStars === 0) return;

            const token = Store.getSessionToken();
            if (!token) { refreshAuthUI(); return; }

            const btn = panel.querySelector('.js-submit');
            btn.disabled = true; btn.textContent = 'Submitting…';

            try {
                const r = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: `${getServerUrl()}/reviews`,
                        headers: {
                            'Content-Type':  'application/json',
                            'Authorization': `Bearer ${token}`,
                        },
                        data: JSON.stringify({
                            targetUserId: currentUserId,
                            stars:        selectedStars,
                            text,
                        }),
                        timeout: 8000,
                        onload: resolve, onerror: reject, ontimeout: reject,
                    });
                });
                if (r.status === 200 || r.status === 201) {
                    ta.value = ''; selectedStars = 0; highlightStars(0);
                    charEl.textContent = `0 / ${MAX_CHARS}`;
                    notify('✓ Review posted!', 'success');
                    await loadReviews(currentUserId);
                } else if (r.status === 401) {
                    Store.clearSession();
                    refreshAuthUI();
                    errEl.textContent = '✗ Session expired — please log in again';
                } else {
                    try {
                        const body = JSON.parse(r.responseText);
                        errEl.textContent = `✗ ${body.error || 'Server error: ' + r.status}`;
                    } catch {
                        errEl.textContent = `✗ Server error: ${r.status}`;
                    }
                }
            } catch (e) {
                errEl.textContent = `✗ Could not reach review server.`;
            } finally {
                btn.textContent = 'Submit';
                validateSubmit();
            }
        });

        panel.querySelector('.tb-reviews-close').addEventListener('click', closePanel);
        backdrop.addEventListener('click', closePanel);

        refreshAuthUI();
    }

    async function loadReviews(userId) {
        const list = panel.querySelector('.js-list');
        const countEl = panel.querySelector('.js-count');
        list.innerHTML = `<div class="tb-reviews-loading"><span class="tb-spinner"></span></div>`;
        try {
            const serverUrl = Store.get('review_server_url', 'http://localhost:3000').replace(/\/+$/, '');
            const r = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `${serverUrl}/reviews/${userId}`,
                    timeout: 8000,
                    onload: resolve, onerror: reject, ontimeout: reject,
                });
            });
            const reviews = JSON.parse(r.responseText);
            countEl.textContent = reviews.length;
            if (!reviews.length) {
                list.innerHTML = `<div class="tb-reviews-empty">No reviews yet.<br><small>Be the first to leave one!</small></div>`;
                return;
            }
            list.innerHTML = '';
            reviews.slice().reverse().forEach(rv => {
                const card = document.createElement('div');
                card.className = 'tb-review-card';
                card.innerHTML = `
                    <div class="tb-review-card-top">
                        <a class="tb-review-author" href="https://osu.ppy.sh/users/${encodeURIComponent(rv.authorUsername)}" target="_blank">
                            ${escapeHtml(rv.authorUsername)}
                        </a>
                        <div class="tb-review-stars">
                            ${[1,2,3,4,5].map(i => `<span class="tb-review-star ${i <= rv.stars ? 'filled' : ''}">★</span>`).join('')}
                        </div>
                    </div>
                    <div class="tb-review-body">${escapeHtml(rv.text)}</div>
                    <div class="tb-review-date">${new Date(rv.createdAt).toLocaleDateString()}</div>
                `;
                list.appendChild(card);
            });
        } catch {
            list.innerHTML = `<div class="tb-reviews-empty">Could not load reviews.<br><small>Is the review server running?</small></div>`;
            countEl.textContent = '?';
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function openPanel(userId) {
        buildPanel();
        currentUserId = userId;
        panel.classList.add('open');
        backdrop.classList.add('open');
        loadReviews(userId);
        // Silently verify session is still valid when panel opens
        verifySession().then(user => {
            if (!user && Store.getSessionToken()) {
                // Token was set but is now invalid — clear it and refresh UI
                const authPrompt = panel.querySelector('.js-auth-prompt');
                const writeForm  = panel.querySelector('.js-write-form');
                if (authPrompt) authPrompt.style.display = 'flex';
                if (writeForm)  writeForm.style.display  = 'none';
            }
        });
    }

    function closePanel() {
        panel?.classList.remove('open');
        backdrop?.classList.remove('open');
    }

    function injectButton() {
        if (document.querySelector('.tb-reviews-btn-wrap')) return;
        const bar = document.querySelector('.profile-detail-bar');
        if (!bar) return;
        const userId = getProfileUserId();
        if (!userId) return;

        const wrap = document.createElement('div');
        wrap.setAttribute('data-orig-title', 'reviews');

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'user-action-button user-action-button--profile-page tb-reviews-btn-wrap';
        btn.innerHTML = `
            <span class="user-action-button__icon-container">
                <span class="fas fa-comments"></span>
            </span>
            <span class="user-action-button__counter">…</span>
        `;
        wrap.appendChild(btn);
        bar.appendChild(wrap);

        btn.addEventListener('click', () => openPanel(userId));

        // Fetch count without opening
        (async () => {
            try {
                const serverUrl = Store.get('review_server_url', 'http://localhost:3000').replace(/\/+$/, '');
                const r = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET', url: `${serverUrl}/reviews/${userId}`, timeout: 5000,
headers: { 'X-Review-Token': Store.getReviewToken() },
                        onload: resolve, onerror: reject, ontimeout: reject,
                    });
                });
                const reviews = JSON.parse(r.responseText);
                btn.querySelector('.user-action-button__counter').textContent = reviews.length;
            } catch {
                btn.querySelector('.user-action-button__counter').textContent = '?';
            }
        })();
    }

    function tryInject() {
        if (!/\/users\//.test(location.pathname)) return;
        injectButton();
    }

    setTimeout(tryInject, 800);
    setTimeout(tryInject, 2000);
    setTimeout(tryInject, 4000);
    new MutationObserver(() => tryInject()).observe(document.body, { childList: true, subtree: true });
    ['pushState','replaceState'].forEach(m => {
        const o = history[m]; history[m] = (...a) => { o.apply(history,a); document.querySelector('.tb-reviews-btn-wrap')?.remove(); setTimeout(tryInject, 800); };
    });
    window.addEventListener('popstate', () => { document.querySelector('.tb-reviews-btn-wrap')?.remove(); setTimeout(tryInject, 800); });
})();

        const gifMgr = new GifManager();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(() => gifMgr.init(), 800);
                setTimeout(() => gifMgr._scan(), 2500);
            });
        } else {
            setTimeout(() => gifMgr.init(), 800);
            setTimeout(() => gifMgr._scan(), 2500);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  MODULE 4 — MANIA RANKING CRITERIA BPM SCALER
    // ═══════════════════════════════════════════════════════════════════════════
    const isManiaWiki = /osu[!%21]?mania/i.test(location.href) ||
        (location.href.includes('Ranking_criteria') && document.body?.textContent?.includes('osu!mania'));

    if (isManiaWiki) {
        const MIN_BPM = 45, MAX_BPM = 360, DEFAULT_BPM = 180;
        const originalTexts = new Map();
        let bpmInitialized = false;
        let currentBPM = DEFAULT_BPM;
        let highlightColor = '#ffffff';

        const COLOR_PRESETS = [
            { name: 'Orange', value: '#ff6b35' },{ name: 'Blue', value: '#4a9eff' },
            { name: 'Green', value: '#00d084' },  { name: 'Purple', value: '#8b5cf6' },
            { name: 'Pink', value: '#f472b6' },   { name: 'Red', value: '#ef4444' },
            { name: 'Cyan', value: '#06b6d4' },   { name: 'Yellow', value: '#eab308' }
        ];

        const BPM_PRESETS = [
            { bpm: 45, multiplier: "0.25x" },{ bpm: 75, multiplier: "0.42x" },
            { bpm: 90, multiplier: "0.5x" }, { bpm: 120, multiplier: "0.67x" },
            { bpm: 180, multiplier: "1x" },  { bpm: 240, multiplier: "1.33x" },
            { bpm: 270, multiplier: "1.5x" },{ bpm: 300, multiplier: "1.67x" },
            { bpm: 330, multiplier: "1.83x" },{ bpm: 360, multiplier: "2x" }
        ];

        function bpmHexToRgb(hex) {
            const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return r ? { r: parseInt(r[1],16), g: parseInt(r[2],16), b: parseInt(r[3],16) } : null;
        }

        function updateBpmColorVars() {
            const root = document.documentElement;
            root.style.setProperty('--bpm-highlight-color', highlightColor);
            const rgb = bpmHexToRgb(highlightColor);
            if (rgb) root.style.setProperty('--bpm-highlight-rgb', `${rgb.r},${rgb.g},${rgb.b}`);
        }

        function addBpmStyles() {
            if (document.getElementById('bpm-enhanced-styles')) return;
            updateBpmColorVars();
            const style = document.createElement('style');
            style.id = 'bpm-enhanced-styles';
            style.textContent = `
                :root { --bpm-highlight-color: ${highlightColor}; --bpm-highlight-rgb: 255,107,53; }
                .bpm-widget { margin-top:24px; padding:16px; background:linear-gradient(135deg,hsl(var(--hsl-b4)) 0%,hsl(var(--hsl-b5)) 100%); border-radius:12px; border:1px solid hsl(var(--hsl-b3)); box-shadow:0 4px 12px hsla(var(--hsl-b1),0.1); position:relative; transition:all 0.3s ease; }
                .bpm-widget:hover { box-shadow:0 6px 20px hsla(var(--hsl-b1),0.15); transform:translateY(-1px); }
                .bpm-widget-title { font-size:16px; font-weight:600; color:hsl(var(--hsl-f1)); margin-bottom:12px; text-align:center; }
                .bpm-display { text-align:center; font-size:24px; font-weight:700; color:hsl(var(--hsl-f1)); margin-bottom:12px; }
                .bpm-value { color:var(--bpm-highlight-color); text-shadow:0 1px 3px rgba(0,0,0,0.3); }
                .bpm-controls-container { display:flex; gap:8px; margin-bottom:12px; justify-content:center; }
                .bpm-btn { flex:1; padding:8px 12px; border:2px solid hsl(var(--hsl-b3)); background:hsl(var(--hsl-b4)); color:hsl(var(--hsl-f1)); border-radius:8px; cursor:pointer; font-size:13px; font-weight:500; transition:all 0.2s ease; min-height:36px; display:flex; align-items:center; justify-content:center; }
                .bpm-btn:hover { background:hsl(var(--hsl-b3)); border-color:var(--bpm-highlight-color); transform:translateY(-1px); box-shadow:0 2px 8px rgba(var(--bpm-highlight-rgb),0.2); }
                .bpm-status { text-align:center; font-size:12px; color:hsl(var(--hsl-f2)); font-style:italic; opacity:0.8; }
                .bpm-dropdown { position:absolute; top:100%; left:0; right:0; background:hsl(var(--hsl-b4)); border:2px solid hsl(var(--hsl-b3)); border-radius:12px; box-shadow:0 8px 24px hsla(var(--hsl-b1),0.25); z-index:1000; opacity:0; visibility:hidden; transform:translateY(-8px) scale(0.95); transition:all 0.25s cubic-bezier(0.4,0,0.2,1); margin-top:8px; max-height:350px; overflow-y:auto; }
                .bpm-dropdown.show { opacity:1; visibility:visible; transform:translateY(0) scale(1); }
                .color-section { padding:16px; border-bottom:1px solid hsl(var(--hsl-b3)); }
                .color-title { font-size:14px; font-weight:600; color:hsl(var(--hsl-f1)); margin-bottom:12px; text-align:center; }
                .color-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; justify-items:center; }
                .color-option { width:28px; height:28px; border-radius:50%; cursor:pointer; border:2px solid transparent; transition:all 0.2s ease; position:relative; }
                .color-option:hover { transform:scale(1.1); }
                .color-option.selected { border-color:hsl(var(--hsl-f1)); transform:scale(1.15); }
                .color-option.selected::after { content:'✓'; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:white; font-size:14px; font-weight:bold; }
                .presets-title { padding:12px 16px 8px; font-size:14px; font-weight:600; color:hsl(var(--hsl-f1)); text-align:center; background:hsl(var(--hsl-b5)); position:sticky; top:0; z-index:1; }
                .bpm-dropdown-option { padding:12px 16px; cursor:pointer; color:hsl(var(--hsl-f1)); transition:all 0.2s ease; border-bottom:1px solid hsl(var(--hsl-b3)); }
                .bpm-dropdown-option:last-child { border-bottom:none; }
                .bpm-dropdown-option:hover { background:linear-gradient(90deg,rgba(var(--bpm-highlight-rgb),0.1),transparent); transform:translateX(2px); }
                .preset-main { display:flex; justify-content:space-between; align-items:center; font-weight:600; }
                .preset-bpm { color:var(--bpm-highlight-color); font-size:16px; }
                .preset-multiplier { color:hsl(var(--hsl-f2)); font-size:14px; }
                .bpm-changed-rule { position:relative; padding:8px 12px; margin:4px -6px; border-radius:6px; background:linear-gradient(135deg,rgba(var(--bpm-highlight-rgb),0.06) 0%,rgba(var(--bpm-highlight-rgb),0.02) 100%); border-left:3px solid var(--bpm-highlight-color); box-shadow:0 1px 4px rgba(var(--bpm-highlight-rgb),0.08); }
            `;
            document.head.appendChild(style);
        }

        function getBpmDescription(bpm) {
            if (bpm <= 60) return "Ultra slow";
            if (bpm <= 90) return "Very slow";
            if (bpm <= 120) return "Slow";
            if (bpm <= 180) return "Normal";
            if (bpm <= 240) return "Fast";
            if (bpm <= 300) return "Very fast";
            if (bpm <= 330) return "Extremely fast";
            return "Ludicrous speed";
        }

        function updateColorSelection() {
            document.querySelectorAll('.color-option').forEach(o => {
                o.classList.toggle('selected', o.style.backgroundColor === highlightColor);
            });
        }

        function storeOriginalContent() {
            originalTexts.clear();
            ['li','p','td','.wiki-page__markdown li','.wiki-page__markdown p'].forEach(sel => {
                document.querySelectorAll(sel).forEach((el, i) => {
                    const t = el.textContent?.trim() || '';
                    if (t.length > 15 && isRelevantManiaRule(t)) {
                        const key = `${sel}_${i}_${t.substring(0,30).replace(/[^\w]/g,'_')}`;
                        if (!originalTexts.has(key))
                            originalTexts.set(key, { element: el, originalHTML: el.innerHTML, originalText: t });
                    }
                });
            });
        }

        function isRelevantManiaRule(text) {
            return [
                /note density should consist of mostly/i,
                /avoid using more than.*consecutive.*notes/i,
                /note snappings of consecutive.*should not be used/i,
                /long notes should be held for at least/i,
                /long-term slider velocity changes should be between/i,
                /slider velocity gimmicks should be reactable/i,
                /avoid anchors consisting of/i,
                /avoid.*split rolls.*streams/i,
                /avoid using more than.*trill/i,
                /avoid using more than.*split-jumptrills/i,
                /avoid unjustified spikes in difficulty/i,
                /beats apart/i,
                /held for at least.*beat/i,
            ].some(r => r.test(text));
        }

        function resetBpmToOriginal() {
            originalTexts.forEach(data => {
                if (data.element?.parentNode) {
                    data.element.innerHTML = data.originalHTML;
                    data.element.classList.remove('bpm-changed-rule');
                }
            });
        }

        function applyBPMScaling(bpm) {
            resetBpmToOriginal();
            if (bpm === DEFAULT_BPM) return;
            let count = 0;
            originalTexts.forEach(data => {
                if (!data.element?.parentNode) return;
                const tl = data.originalText.toLowerCase();
                const rules = [
                    () => applyDensityRule(data.originalHTML, bpm, tl, data.originalText),
                    () => applyConsecutiveRule(data.originalHTML, bpm, tl, data.originalText),
                    () => applyLongNoteRule(data.originalHTML, bpm, tl, data.originalText),
                    () => applySnapRule(data.originalHTML, bpm, tl, data.originalText),
                    () => applyTrillRule(data.originalHTML, bpm, tl, data.originalText),
                    () => applyAnchorRule(data.originalHTML, bpm, tl, data.originalText),
                    () => applySVRule(data.originalHTML, bpm, tl, data.originalText),
                    () => applySVGimmickRule(data.originalHTML, bpm, tl, data.originalText),
                    () => applyStreamRule(data.originalHTML, bpm, tl, data.originalText),
                    () => applyJumptrillRule(data.originalHTML, bpm, tl, data.originalText),
                    () => applySpikeRule(data.originalHTML, bpm, tl, data.originalText),
                ];
                for (const rule of rules) {
                    const result = rule();
                    if (result && result !== data.originalHTML) {
                        data.element.innerHTML = result;
                        data.element.classList.add('bpm-changed-rule');
                        count++;
                        break;
                    }
                }
            });
        }

        function applyDensityRule(html, bpm, tl, ot) {
            if (!/note density should consist of mostly/i.test(ot)) return html;
            const cap = /^Note/i.test(ot);
            const p = (cap ? 'Note' : 'note') + ' density should consist of mostly';
            if (bpm <= 90)  return html.replace(/note density should consist of mostly.*?(patterns?|rhythms?)\.?\s*$/i, `${p} 1/1, frequent 1/2, and occasional 1/4 patterns`);
            if (bpm >= 330) return html.replace(/note density should consist of mostly.*?(patterns?|rhythms?)\.?\s*$/i, `${p} 1/1 notes with very rare 1/2`);
            if (bpm >= 300) return html.replace(/note density should consist of mostly.*?(patterns?|rhythms?)\.?\s*$/i, `${p} almost entirely 1/1 notes`);
            if (bpm >= 240) return html.replace(/note density should consist of mostly.*?(patterns?|rhythms?)\.?\s*$/i, `${p} 1/1 with minimal 1/2 patterns`);
            if (bpm <= 120) return html.replace(/note density should consist of mostly.*?(patterns?|rhythms?)\.?\s*$/i, `${p} 1/2, frequent 1/4, and occasional 1/1 patterns`);
            return html;
        }

        function applyConsecutiveRule(html, bpm, tl, ot) {
            const m = tl.match(/avoid using more than (\d+) consecutive/);
            if (!m) return html;
            const base = parseInt(m[1]);
            let scaled = base;
            if (bpm <= 75)       scaled = Math.floor(base * 2.5);
            else if (bpm <= 90)  scaled = Math.floor(base * 2);
            else if (bpm <= 120) scaled = Math.floor(base * 1.5);
            else if (bpm >= 330) scaled = Math.max(1, Math.floor(base * 0.4));
            else if (bpm >= 300) scaled = Math.max(1, Math.floor(base * 0.5));
            else if (bpm >= 270) scaled = Math.max(2, Math.floor(base * 0.7));
            else if (bpm >= 240) scaled = Math.max(2, Math.floor(base * 0.8));
            if (scaled === base) return html;
            const cap = /^Avoid/i.test(ot);
            return html.replace(/(avoid using more than )\d+( consecutive)/i, `${cap?'Avoid':'avoid'} using more than ${scaled}$2`);
        }

        function applyLongNoteRule(html, bpm, tl, ot) {
            if (!tl.includes('long notes should be held for at least')) return html;
            let dur = null;
            if (bpm <= 75) dur = "1/2 beat";
            else if (bpm <= 90) dur = "3/4 beat";
            else if (bpm >= 330) dur = "2 beats";
            else if (bpm >= 300) dur = "1 1/2 beats";
            else if (bpm >= 240) dur = "1 1/4 beats";
            if (!dur) return html;
            const cap = /^Long/i.test(ot);
            return html.replace(/long notes should be held for at least [\w\s\/\d]+/i, `${cap?'Long':'long'} notes should be held for at least ${dur}`);
        }

        function applySnapRule(html, bpm, tl, ot) {
            if (!tl.includes('should not be used')) return html;
            if (bpm <= 90)  return html.replace(/(should not be used)/i, "$1 (may be used sparingly at low BPM)");
            if (bpm >= 240) return html.replace(/(should not be used)/i, "$1 (strictly enforced at high BPM)");
            return html;
        }

        function applyTrillRule(html, bpm, tl, ot) {
            const m = tl.match(/avoid using more than (\d+) consecutive notes in.*trill/);
            if (!m) return html;
            const base = parseInt(m[1]);
            let lim = base;
            if (bpm <= 90) lim = Math.floor(base * 1.8);
            else if (bpm <= 120) lim = Math.floor(base * 1.4);
            else if (bpm >= 330) lim = Math.max(2, Math.floor(base * 0.5));
            else if (bpm >= 300) lim = Math.max(2, Math.floor(base * 0.6));
            else if (bpm >= 240) lim = Math.max(3, Math.floor(base * 0.8));
            if (lim === base) return html;
            const cap = /^Avoid/i.test(ot);
            return html.replace(/(avoid using more than )\d+( consecutive notes in.*?trill)/i, `${cap?'Avoid':'avoid'} using more than ${lim}$2`);
        }

        function applyAnchorRule(html, bpm, tl, ot) {
            const m = tl.match(/avoid anchors consisting of (\w+) or more notes/);
            if (!m) return html;
            const base = m[1].toLowerCase();
            let nw = base;
            if (bpm <= 120) nw = ({three:'five',four:'six',five:'seven'})[base] || base;
            else if (bpm >= 300) nw = ({four:'three',five:'three',six:'four'})[base] || 'three';
            else if (bpm >= 240) nw = ({four:'three',five:'four',six:'four'})[base] || base;
            if (nw === base) return html;
            const cap = /^Avoid/i.test(ot);
            return html.replace(/(avoid anchors consisting of )\w+( or more notes)/i, `${cap?'Avoid':'avoid'} anchors consisting of ${nw}$2`);
        }

        function applySVRule(html, bpm, tl, ot) {
            const m = tl.match(/long-term slider velocity changes should be between ([\d.]+).*?([\d.]+)/);
            if (!m) return html;
            const bMin = parseFloat(m[1]), bMax = parseFloat(m[2]);
            let aMin = bMin, aMax = bMax, changed = false;
            if (bpm <= 90)       { aMin = Math.max(0.5, bMin-0.15); aMax = Math.min(1.5, bMax+0.15); changed = true; }
            else if (bpm <= 120) { aMin = Math.max(0.6, bMin-0.1);  aMax = Math.min(1.3, bMax+0.1);  changed = true; }
            else if (bpm >= 330) { aMin = Math.max(0.85, bMin+0.15); aMax = Math.min(1.15, bMax-0.1); changed = true; }
            else if (bpm >= 300) { aMin = Math.max(0.8, bMin+0.1);  aMax = Math.min(1.2, bMax-0.05); changed = true; }
            else if (bpm >= 240) { aMin = Math.max(0.75, bMin+0.05); aMax = Math.min(1.25, bMax);    changed = true; }
            if (!changed) return html;
            const cap = /^Long-term/i.test(ot);
            return html.replace(/long-term slider velocity changes should be between ([\d.]+)x?(.*?)([\d.]+)x?/i,
                `${cap?'Long-term':'long-term'} slider velocity changes should be between ${aMin.toFixed(2)}x$2${aMax.toFixed(2)}x`);
        }

        function applySVGimmickRule(html, bpm, tl, ot) {
            const m = tl.match(/slider velocity gimmicks should be reactable within ([\d\/]+)/);
            if (!m) return html;
            const base = m[1];
            let nf = base;
            if (bpm <= 90)       nf = ({  '3/4':'1/2','1/2':'1/4' })[base] || base;
            else if (bpm <= 120) nf = ({ '3/4':'2/3','1/2':'1/3' })[base] || base;
            else if (bpm >= 330) nf = ({ '3/4':'1.5','1/2':'1/1' })[base] || '1/1';
            else if (bpm >= 300) nf = ({ '3/4':'1/1','1/2':'3/4' })[base] || base;
            else if (bpm >= 240) nf = ({ '1/2':'2/3' })[base] || base;
            if (nf === base) return html;
            const cap = /^Slider/i.test(ot);
            return html.replace(/slider velocity gimmicks should be reactable within [\d\/]+/i,
                `${cap?'Slider velocity':'slider velocity'} gimmicks should be reactable within ${nf}`);
        }

        function applyStreamRule(html, bpm, tl, ot) {
            if (!tl.includes('split rolls') && !tl.includes('streams')) return html;
            const cap = /^Avoid/i.test(ot);
            const p = cap ? 'Avoid' : 'avoid';
            if (bpm <= 90)  return html.replace(/(avoid.*?split rolls.*?streams lasting longer than )(\d+)( beats?)/i, `${p} split rolls and complex 1/8 streams lasting longer than 4-6$3 (extended patterns allowed at low BPM)`);
            if (bpm >= 300) return html.replace(/(avoid.*?split rolls.*?streams)/i, `${p} any complex 1/8 streams entirely at extreme BPM`);
            if (bpm >= 240) return html.replace(/(lasting longer than )(\d+)( beats?)/i, "$1 1$3");
            return html;
        }

        function applyJumptrillRule(html, bpm, tl, ot) {
            const m = tl.match(/avoid using more than (\d+)-note split-jumptrills/);
            if (!m) return html;
            const base = parseInt(m[1]);
            let lim = base;
            if (bpm <= 90) lim = Math.floor(base * 1.6);
            else if (bpm <= 120) lim = Math.floor(base * 1.3);
            else if (bpm >= 300) lim = Math.max(3, Math.floor(base * 0.6));
            else if (bpm >= 240) lim = Math.max(4, Math.floor(base * 0.8));
            if (lim === base) return html;
            const cap = /^Avoid/i.test(ot);
            return html.replace(/(avoid using more than )\d+(-note split-jumptrills)/i, `${cap?'Avoid':'avoid'} using more than ${lim}$2`);
        }

        function applySpikeRule(html, bpm, tl, ot) {
            if (!tl.includes('unjustified spikes in difficulty')) return html;
            const cap = /^Avoid/i.test(ot);
            const base = `${cap?'Avoid':'avoid'} unjustified spikes in difficulty`;
            if (bpm >= 330) return html.replace(/avoid unjustified spikes in difficulty[^.]*/i, `${base} — extreme BPM makes complex patterns unreadable`);
            if (bpm >= 300) return html.replace(/(avoid unjustified spikes in difficulty)/i, `${base} — extreme BPM requires maximum caution`);
            if (bpm >= 240) return html.replace(/(avoid unjustified spikes in difficulty)/i, `${base} — high BPM requires extra caution`);
            if (bpm <= 90)  return html.replace(/(avoid unjustified spikes in difficulty)/i, `${base} (slower BPM allows more complex patterns when appropriate)`);
            return html;
        }

        function createBpmUI() {
            if (document.getElementById('bpm-adjuster-widget')) return;
            const sidebar = document.querySelector('.sidebar .js-mobile-toggle[data-mobile-toggle-id="wiki-toc"]');
            if (!sidebar) return;

            addBpmStyles();

            const widget = document.createElement('div');
            widget.id = 'bpm-adjuster-widget';
            widget.className = 'bpm-widget';

            const bpmDisplay = document.createElement('div');
            bpmDisplay.className = 'bpm-display';
            bpmDisplay.innerHTML = `<span class="bpm-value">${DEFAULT_BPM}</span> BPM`;

            const controls = document.createElement('div');
            controls.className = 'bpm-controls-container';

            const presetsBtn = document.createElement('button');
            presetsBtn.textContent = 'Presets';
            presetsBtn.className = 'bpm-btn';

            const resetBtn = document.createElement('button');
            resetBtn.textContent = 'Reset';
            resetBtn.className = 'bpm-btn';

            const status = document.createElement('div');
            status.className = 'bpm-status';

            const dropdown = document.createElement('div');
            dropdown.className = 'bpm-dropdown';

            const colorSection = document.createElement('div');
            colorSection.className = 'color-section';
            colorSection.innerHTML = '<div class="color-title">Highlight Color</div>';
            const colorGrid = document.createElement('div');
            colorGrid.className = 'color-grid';
            COLOR_PRESETS.forEach(c => {
                const o = document.createElement('div');
                o.className = 'color-option';
                o.style.backgroundColor = c.value;
                o.title = c.name;
                o.addEventListener('click', () => {
                    highlightColor = c.value;
                    updateBpmColorVars();
                    if (bpmInitialized) applyBPMScaling(currentBPM);
                    updateColorSelection();
                });
                colorGrid.appendChild(o);
            });
            colorSection.appendChild(colorGrid);

            const presetsSection = document.createElement('div');
            presetsSection.className = 'presets-section';
            presetsSection.innerHTML = '<div class="presets-title">BPM Presets</div>';
            BPM_PRESETS.forEach(p => {
                const opt = document.createElement('div');
                opt.className = 'bpm-dropdown-option';
                opt.innerHTML = `<div class="preset-main"><div class="preset-bpm">${p.bpm}</div><div class="preset-multiplier">${p.multiplier}</div></div>`;
                opt.addEventListener('click', () => { updateBpm(p.bpm); dropdown.classList.remove('show'); });
                presetsSection.appendChild(opt);
            });

            dropdown.appendChild(colorSection);
            dropdown.appendChild(presetsSection);

            function updateBpm(bpm) {
                bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, bpm));
                currentBPM = bpm;
                bpmDisplay.innerHTML = `<span class="bpm-value">${bpm}</span> BPM`;
                status.textContent = bpm === DEFAULT_BPM ? '' : getBpmDescription(bpm);
                applyBPMScaling(bpm);
            }

            presetsBtn.addEventListener('click', e => { e.stopPropagation(); dropdown.classList.toggle('show'); });
            resetBtn.addEventListener('click', () => { updateBpm(DEFAULT_BPM); dropdown.classList.remove('show'); });
            document.addEventListener('click', e => { if (!widget.contains(e.target)) dropdown.classList.remove('show'); });

            const title = document.createElement('div');
            title.className = 'bpm-widget-title';
            title.textContent = 'BPM Scaling';

            controls.appendChild(presetsBtn);
            controls.appendChild(resetBtn);
            widget.appendChild(title);
            widget.appendChild(bpmDisplay);
            widget.appendChild(controls);
            widget.appendChild(status);
            widget.appendChild(dropdown);
            sidebar.appendChild(widget);

            updateColorSelection();

            setTimeout(() => {
                storeOriginalContent();
                applyBPMScaling(DEFAULT_BPM);
                bpmInitialized = true;
            }, 500);
        }

        function tryBpmInit() {
            if (document.readyState === 'complete') setTimeout(createBpmUI, 500);
            else setTimeout(tryBpmInit, 100);
        }
        tryBpmInit();
        [2000, 5000, 10000].forEach(d => setTimeout(() => { if (!document.getElementById('bpm-adjuster-widget')) createBpmUI(); }, d));
    }

})();
