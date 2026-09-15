// 页面：原建档/帆索任务流程完整保留，新增“多索联调”页签。
export function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --risk:#8a6d1f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; }
    main { padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; font-family:monospace; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.danger { background:var(--warn); } button:disabled { opacity:.5; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; }
    .tabs { display:flex; gap:8px; margin-bottom:16px; } .tabs button { background:#dde4d8; color:var(--ink); } .tabs button.active { background:var(--accent); color:#fff; }
    .hidden { display:none; }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { border:1px solid var(--line); padding:6px 8px; text-align:left; } th { background:#eef2ea; }
    .alert { border-radius:6px; padding:10px 12px; margin:8px 0; font-size:14px; }
    .alert.block { background:#f7e3de; border:1px solid var(--warn); color:var(--warn); font-weight:700; }
    .alert.risk { background:#f7f0da; border:1px solid var(--risk); color:var(--risk); }
    .alert.ok { background:#e3efdc; border:1px solid var(--accent); color:var(--accent); font-weight:700; }
    .tag-ok { color:var(--accent); font-weight:700; } .tag-bad { color:var(--warn); font-weight:700; }
    .two { display:grid; grid-template-columns:380px 1fr; gap:22px; }
    .rowline { display:flex; gap:8px; align-items:center; } .rowline input[type=number] { width:110px; }
    .mono { font-family:monospace; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{padding:16px;} .two{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务与多索联调（安全区间 · 影响系数 · 原子应用）</div></div>
    <div class="rowline"><span class="meta">操作员令牌</span><input id="operator" style="width:160px" placeholder="ASCII，如 zhouning" value="zhouning"><button id="reload">刷新</button></div>
  </header>
  <main>
    <div class="tabs">
      <button id="tabLegacy" class="active">建档 / 帆索任务（原流程）</button>
      <button id="tabAdjust">多索联调</button>
    </div>

    <!-- ============ 原流程（保持可用） ============ -->
    <section id="viewLegacy">
      <div class="two">
        <div>
          <form id="createForm" class="panel"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status"></select><button>保存模型</button></form>
          <form id="actionForm" class="panel" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
        </div>
        <div>
          <div class="stats" id="stats"></div>
          <div class="toolbar"><select id="statusFilter"></select><input id="search" placeholder="搜索编号或关键词"></div>
          <div class="panel"><h2>创建模型后可拆分帆索任务，逐条记录松紧状态、调整备注和完成时间。</h2><div class="grid" id="cards"></div></div>
        </div>
      </div>
    </section>

    <!-- ============ 多索联调 ============ -->
    <section id="viewAdjust" class="hidden">
      <div class="two">
        <div>
          <div class="panel">
            <h2>1. 选择模型</h2>
            <select id="adjItem"></select>
            <div class="meta" id="adjMeta"></div>
          </div>
          <div class="panel" style="margin-top:14px">
            <h2>2. 登记索（张力 / 安全区间 / 影响系数）</h2>
            <label>索编号</label><input id="rId" placeholder="如 R1">
            <label>名称</label><input id="rName" placeholder="前桅侧支索">
            <div class="rowline">
              <div style="flex:1"><label>当前张力 N</label><input id="rTension" type="number" step="0.1" value="50"></div>
              <div style="flex:1"><label>下限</label><input id="rMin" type="number" step="0.1" value="30"></div>
              <div style="flex:1"><label>上限</label><input id="rMax" type="number" step="0.1" value="80"></div>
            </div>
            <label>影响系数（调本索 1N 引起其他索的张力变化，JSON）</label>
            <textarea id="rInfluence" placeholder='{"R2":0.3,"R3":-0.1}  对角缺省为 1'>{}</textarea>
            <div style="margin-top:10px"><button id="btnRegister">登记 / 更新该索</button></div>
            <h3 style="margin-top:14px">已登记索</h3>
            <div id="ropeTable"></div>
          </div>
        </div>
        <div>
          <div class="panel">
            <h2>3. 选择多根索的目标张力并预览方案</h2>
            <div id="targetPicker"></div>
            <div class="rowline" style="margin-top:10px">
              <button id="btnPreview">方案预览（不改动数据）</button>
              <span class="meta" id="previewHint"></span>
            </div>
            <div id="preview"></div>
          </div>
          <div class="panel" style="margin-top:14px">
            <h2>4. 原子应用与撤销</h2>
            <div class="rowline">
              <button id="btnApply" disabled>按版本原子应用</button>
              <button id="btnUndo" class="secondary" disabled>撤销上次安全结果</button>
            </div>
            <div id="lastSafeLine" class="meta" style="margin-top:8px"></div>
            <div id="applyResult"></div>
          </div>
        </div>
      </div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
    const $ = s => document.querySelector(s);
    const operator = () => ($('#operator').value || '').trim();
    $('#operator').value = localStorage.getItem('rig-operator') || 'zhouning';
    $('#operator').oninput = () => localStorage.setItem('rig-operator', $('#operator').value);

    async function api(path, options = {}) {
      // HTTP 头只允许 ISO-8859-1：操作员令牌统一百分号编码（服务端 decodeURIComponent，ASCII 令牌不受影响）
      const opts = { ...options, headers: { 'X-Operator': encodeURIComponent(operator()), ...(options.headers || {}) } };
      if (options.body) opts.headers['Content-Type'] = 'application/json';
      const res = await fetch(path, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(data.message || data.error || '请求失败'); e.status = res.status; e.data = data; throw e; }
      return data;
    }

    /* ---------- 原流程 ---------- */
    let items = [];
    function renderForms() {
      $('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      $('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
      document.querySelector('#createForm select[name=status]').innerHTML = stages.map(s => '<option>'+s+'</option>').join('');
      $('#statusFilter').innerHTML = '<option value="">全部状态</option>' + stages.map(s => '<option>'+s+'</option>').join('');
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+(l.step||'备注')+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks
        + '<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'
        + '<button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button>'
        + '<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function renderLegacy() {
      $('#itemSelect').innerHTML = items.map(i => '<option value="'+(i.id||i.code)+'">'+(i.code||i.id)+' · '+(i.shipType||'')+'</option>').join('');
      $('#stats').innerHTML = stages.map(s => '<div class="stat"><span>'+s+'</span><strong>'+items.filter(i=>i.status===s).length+'</strong></div>').join('');
      const status = $('#statusFilter').value || '';
      const q = $('#search').value.trim();
      const visible = items.filter(i => (!status || i.status === status) && (!q || JSON.stringify(i).includes(q)));
      $('#cards').innerHTML = visible.map(cardHtml).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await loadAll();
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => {
        const note = prompt('记录备注'); if (note) { await api('/api/items/'+btn.dataset.note+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await loadAll(); }
      });
    }

    /* ---------- 多索联调 ---------- */
    let currentItem = null;   // 列表中的精简对象
    let detail = null;        // 详情
    let pendingPlan = null;   // 预览返回的可执行方案
    let loadGen = 0;          // 加载代次：防止旧请求晚返回覆盖新状态

    function renderAdjustMeta() {
      if (!detail) return;
      $('#adjMeta').innerHTML = '负责人 <b>'+(detail.owner||'（未指派）')+'</b> · 数据版本 <b>v'+detail.version+'</b> · 索 <b>'+(detail.ropes||[]).length+'</b> 根';
      const rows = (detail.ropes||[]).map(r => '<tr><td>'+r.id+'</td><td>'+r.name+'</td><td class="mono">'+r.tension+'</td><td class="mono">['+r.min+', '+r.max+']</td><td class="mono">'+JSON.stringify(r.influence||{})+'</td></tr>').join('');
      $('#ropeTable').innerHTML = rows
        ? '<table><tr><th>编号</th><th>名称</th><th>当前</th><th>安全区间</th><th>影响系数</th></tr>'+rows+'</table>'
        : '<div class="meta">尚未登记索</div>';
      $('#targetPicker').innerHTML = (detail.ropes||[]).map(r =>
        '<div class="rowline" style="margin:6px 0"><input type="checkbox" data-target="'+r.id+'" style="width:auto"> <b style="width:60px">'+r.id+'</b>'
        + '<span class="meta" style="flex:1">当前 '+r.tension+' / 区间 ['+r.min+', '+r.max+']</span>'
        + '目标 <input type="number" step="0.1" data-value="'+r.id+'"></div>').join('') || '<div class="meta">请先在左侧登记索</div>';
      const lsr = detail.lastSafeResult;
      $('#btnUndo').disabled = !(lsr && lsr.undoable);
      $('#lastSafeLine').innerHTML = lsr
        ? '上次安全结果：方案 '+lsr.planId+'，'+(lsr.undoable?'<span class="tag-ok">可撤销</span>':'<span class="meta">已撤销</span>')
        : '<span class="meta">尚无安全应用结果</span>';
    }

    function renderPreview(p, banner = '') {
      const block = (p.blockers||[]).map(b => '<div>⛔ '+b.message+'</div>').join('');
      const risk = (p.risks||[]).map(r => '<div>⚠ '+r.message+'</div>').join('');
      const finals = Object.entries(p.finalTensions||{}).map(([id,v]) => {
        const rp = (detail.ropes||[]).find(x=>x.id===id);
        const inside = rp ? v >= rp.min && v <= rp.max : true;
        return '<tr><td>'+id+'</td><td class="mono">'+(rp?rp.tension:'-')+'</td><td class="mono '+(inside?'tag-ok':'tag-bad')+'">'+v+'</td><td class="mono">'+(rp?'['+rp.min+', '+rp.max+']':'-')+'</td></tr>';
      }).join('');
      const steps = (p.steps||[]).map(s => '<tr><td>'+s.step+'</td><td>'+s.ropeId+'</td><td class="mono">'+(s.adjust>=0?'+':'')+s.adjust+'</td><td class="mono">'+Object.entries(s.tensions||{}).map(([k,v])=>k+'='+v).join(' ')+'</td></tr>').join('');
      $('#preview').innerHTML =
        banner
        + '<div class="meta" style="margin-top:10px">方案 '+p.id+' · 基于版本 v'+p.baseVersion+'（当前 v'+p.currentVersion+'）</div>'
        + (p.converged ? '<div class="alert ok">✅ 收敛：残差 '+p.residual+' N，扫掠 '+(p.sweeps)+' 轮，终值均在安全区间内</div>'
                       : '<div class="alert block">❌ 未收敛或不可执行</div>')
        + (block ? '<div class="alert block">'+block+'</div>' : '')
        + (risk ? '<div class="alert risk">'+risk+'</div>' : '')
        + (steps ? '<h3 style="margin:10px 0 6px">逐步调节量与预测</h3>'
        + '<table><tr><th>步</th><th>调节索</th><th>调节量</th><th>调节后各索张力</th></tr>'+steps+'</table>' : '')
        + (finals ? '<h3 style="margin:10px 0 6px">预测终值</h3>'
        + '<table><tr><th>索</th><th>调节前</th><th>预测终值</th><th>安全区间</th></tr>'+finals+'</table>' : '');
    }

    async function loadDetail() {
      const key = $('#adjItem').value;
      const gen = ++loadGen;
      if (!key) { detail = null; return; }
      const d = await api('/api/items/'+encodeURIComponent(key));
      if (gen !== loadGen || $('#adjItem').value !== key) return; // 已被更新的切换取代
      currentItem = items.find(i => (i.id||i.code) === key);
      detail = d;
      pendingPlan = null; $('#btnApply').disabled = true;
      renderAdjustMeta();
    }

    $('#btnRegister').onclick = async () => {
      try {
        let influence = {};
        try { influence = JSON.parse($('#rInfluence').value || '{}'); }
        catch { throw new Error('影响系数不是合法 JSON'); }
        const ropes = [{
          id: $('#rId').value.trim(), name: $('#rName').value.trim() || $('#rId').value.trim(),
          tension: Number($('#rTension').value), min: Number($('#rMin').value), max: Number($('#rMax').value), influence,
        }];
        await api('/api/items/'+encodeURIComponent($('#adjItem').value)+'/ropes', { method:'POST', body: JSON.stringify({ ropes }) });
        await loadAll();
      } catch (e) { alert('登记被拒绝：' + e.message); }
    };

    $('#btnPreview').onclick = async () => {
      const targets = [...document.querySelectorAll('[data-target]')].filter(c => c.checked).map(c => {
        const v = Number(document.querySelector('[data-value="'+c.dataset.target+'"]').value);
        return { id: c.dataset.target, target: v };
      });
      if (!targets.length) return alert('请至少勾选一根目标索并填写目标值');
      $('#preview').innerHTML = '<div class="meta">计算中…</div>';
      try {
        pendingPlan = await api('/api/items/'+encodeURIComponent($('#adjItem').value)+'/plans', { method:'POST', body: JSON.stringify({ targets }) });
        $('#previewHint').textContent = '';
        renderPreview(pendingPlan);
        $('#btnApply').disabled = false;
      } catch (e) {
        pendingPlan = null; $('#btnApply').disabled = true;
        if (e.status === 422 && e.data && e.data.preview) {
          // 阻塞：服务端随 422 返回预览载荷；原记录未改动，方案不落库
          const p = e.data.preview;
          p.id = '（已拒绝，未落库）'; p.baseVersion = detail.version; p.currentVersion = detail.version; p.status = 'rejected';
          renderPreview(p, '<div class="alert block">🚫 ' + e.message + '</div>');
        } else if (e.status === 409) {
          $('#preview').innerHTML = '<div class="alert block">冲突：'+e.message+'</div>';
        } else {
          $('#preview').innerHTML = '<div class="alert block">错误：'+e.message+'</div>';
        }
      }
    };

    $('#btnApply').onclick = async () => {
      if (!pendingPlan) return;
      $('#applyResult').innerHTML = '<div class="meta">应用中…</div>';
      try {
        const out = await api('/api/items/'+encodeURIComponent($('#adjItem').value)+'/plans/'+pendingPlan.id+'/apply',
          { method:'POST', body: JSON.stringify({ expectedVersion: pendingPlan.baseVersion }) });
        $('#applyResult').innerHTML = '<div class="alert ok">'+(out.idempotent?'该方案已应用过，本次为重复提交，只生效一次 ✅':'原子应用成功 ✅')
          +'（当前版本 v'+out.version+'）</div>';
        pendingPlan = null; $('#btnApply').disabled = true;
        await loadAll();
      } catch (e) {
        if (e.status === 409) {
          $('#applyResult').innerHTML = '<div class="alert block">应用被拒绝（冲突）：'+e.message+'。数据未改动，请刷新后重新预览。</div>';
        } else if (e.status === 403) {
          $('#applyResult').innerHTML = '<div class="alert block">越权拒绝：'+e.message+'</div>';
        } else {
          $('#applyResult').innerHTML = '<div class="alert block">应用失败已整体回滚：'+e.message+'</div>';
        }
        pendingPlan = null; $('#btnApply').disabled = true;
        await loadDetailSafe();
      }
    };

    $('#btnUndo').onclick = async () => {
      const lsr = detail.lastSafeResult;
      if (!lsr) return;
      try {
        await api('/api/items/'+encodeURIComponent($('#adjItem').value)+'/plans/'+lsr.planId+'/undo', { method:'POST', body:'{}' });
        await loadAll();
      } catch (e) { alert('撤销失败：'+e.message); }
    };

    async function loadDetailSafe() { try { await loadDetail(); } catch {} }

    /* ---------- 装配 ---------- */
    $('#tabLegacy').onclick = () => { $('#viewLegacy').classList.remove('hidden'); $('#viewAdjust').classList.add('hidden'); $('#tabLegacy').classList.add('active'); $('#tabAdjust').classList.remove('active'); };
    $('#tabAdjust').onclick = () => { $('#viewAdjust').classList.remove('hidden'); $('#viewLegacy').classList.add('hidden'); $('#tabAdjust').classList.add('active'); $('#tabLegacy').classList.remove('active'); loadAll(); };
    $('#adjItem').onchange = loadDetail;
    $('#createForm').onsubmit = async ev => { ev.preventDefault();
      const payload = Object.fromEntries(new FormData($('#createForm')).entries());
      payload.ownerToken = operator(); // 当前操作员令牌，便于后续联调鉴权
      await api('/api/items', { method:'POST', body: JSON.stringify(payload) });
      $('#createForm').reset(); await loadAll();
    };
    $('#actionForm').onsubmit = async ev => { ev.preventDefault(); await api('/api/items/'+$('#itemSelect').value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData($('#actionForm')).entries())) }); $('#actionForm').reset(); await loadAll(); };
    $('#statusFilter').onchange = renderLegacy; $('#search').oninput = renderLegacy;
    $('#reload').onclick = () => loadAll();

    async function loadAll() {
      const gen = ++loadGen;
      const list = await api('/api/items');
      if (gen !== loadGen) return; // 已有更新的加载发起
      items = list;
      renderLegacy();
      const sel = $('#adjItem');
      const prev = sel.value;
      sel.innerHTML = items.map(i => '<option value="'+(i.id||i.code)+'">'+(i.code||i.id)+' · '+(i.shipType||'')+' · 负责人 '+((i.owner||'未指派'))+'</option>').join('');
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
      if (items.length) await loadDetailSafe();
    }
    renderForms(); loadAll();
  </script>
</body>
</html>`;
}
