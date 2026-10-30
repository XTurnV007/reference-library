'use strict';
window.GalleryAnalytics = (() => {
  const $=s=>document.querySelector(s);
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names={pose:'姿势参考',costume:'服装参考'};
  const cats={'ランジェリー':'内衣','パーティ':'派对','水着':'泳装','セクシー':'性感'};
  const labels={today:'今日热门',week:'本周热门',all:'总浏览榜',rising:'上升榜'};
  let config, provider, open, catalog=[], catalogAt=0, mode='', period='week', sequence=0, shelfSequence=0;
  let active=null,timer=null,detailSequence=0, visitorMemory='', visitorExpires=0, optedOut=false;
  const cache=new Map();
  try{optedOut=localStorage.getItem('reference-library.analytics.off')==='1';}catch(_){}
  function message(error){return error?.message||'统计服务暂时不可用，图库仍可正常浏览';}
  async function settings(){
    if(!config) config=window.StaticLibrary ? fetch('./analytics-config.json').then(r=>{
      if(!r.ok)throw new Error('未配置统计服务');return r.json();
    }) : Promise.resolve({base_url:location.origin});
    let c;
    try{c=await config;}catch(e){config=null;throw e;}
    if(!c.base_url)throw new Error('未配置共享统计服务；图库可正常浏览，配置后开始积累真实数据');
    const base=new URL(c.base_url);
    if(!['https:','http:'].includes(base.protocol)||base.search||base.hash)throw new Error('统计地址配置无效');
    return base.href.replace(/\/$/,'');
  }
  async function request(path,body){
    const base=await settings(),key=base+path;
    const old=cache.get(key);
    if(body===undefined && old && Date.now()<old.expires)return old.data;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),6000);
    try{
      const response=await fetch(key,{method:body===undefined?'GET':'POST',credentials:'omit',signal:controller.signal,
        ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'统计暂时不可用');
      if(body===undefined){
        if(cache.size>80)cache.clear();
        const generated=Date.parse(result.updated_at);
        const remaining=Number.isFinite(generated)?Math.max(0,Math.min(300000,300000-(Date.now()-generated))):0;
        cache.set(key,{expires:Date.now()+remaining,data:result});
      }
      return result;
    }catch(e){if(e.name==='AbortError')throw new Error('统计连接超时，图库仍可正常浏览');throw e;}
    finally{clearTimeout(timeout);}
  }
  async function items(){
    if(!catalogAt || Date.now()-catalogAt>300000){catalog=(await provider('/api/export')).items;catalogAt=Date.now();}
    return catalog;
  }
  function params(extra={}){
    return new URLSearchParams({source:$('#rankSource').value,category:$('#rankCategory').value,...extra});
  }
  function note(data){return `统计始于 ${data.started_at.slice(0,10)} · 汇总于 ${data.updated_at.slice(0,16).replace('T',' ')}（UTC+08:00）· 约 5 分钟更新。姿势按组去重；浏览次数不等于独立人数。`;}
  function chart(rows,title){
    const max=Math.max(1,...rows.map(r=>r.views)),height=120,width=640;
    const points=rows.map((r,i)=>`${12+i*(width-24)/Math.max(1,rows.length-1)},${height-15-r.views/max*(height-35)}`).join(' ');
    const total=rows.reduce((n,r)=>n+r.views,0);
    return `<div class="trend-chart"><h3>${escape(title)} <small>${total.toLocaleString()} 次</small></h3><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(title)}，共 ${total} 次有效浏览"><line x1="12" y1="${height-15}" x2="${width-12}" y2="${height-15}" class="chart-base"/><polyline points="${points}" class="chart-line"/></svg><div class="chart-dates"><span>${escape(rows[0]?.day||'')}</span><span>每日有效浏览 · 峰值 ${max===1&&!total?0:max}</span><span>${escape(rows.at(-1)?.day||'')}</span></div><details><summary>查看每日数据</summary><div class="daily-table"><table><thead><tr><th>日期</th><th>有效浏览</th><th>下载点击</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escape(r.day)}</td><td>${r.views}</td><td>${r.downloads}</td></tr>`).join('')}</tbody></table></div></details></div>`;
  }
  function badge(entry){return entry.delta>0?`<span class="rising-badge">↑ ${entry.delta}</span>`:'';}
  function card(entry,item,small=false){
    return `<button class="${small?'hot-card':'rank-card'}" data-insight-item="${escape(item.id)}"><span class="rank-number">${entry.rank.toString().padStart(2,'0')}</span>${item.preview?`<img src="${escape(item.preview)}" alt="${escape(item.title)}" loading="lazy">`:'<span>暂无图片</span>'}<span class="rank-copy"><strong>${escape(item.title)}</strong><span>${escape(cats[item.category]||item.category)} · ${names[item.source]}</span><small>${entry.views.toLocaleString()} 次有效浏览 ${period!=='all'?badge(entry):''}</small></span></button>`;
  }
  async function shelf(){
    const seq=++shelfSequence;
    try{
      const [data,all]=await Promise.all([request('/api/analytics/leaderboard?period=week&limit=6'),items()]);
      if(seq!==shelfSequence)return;
      const map=new Map(all.map(i=>[i.id,i]));
      $('#analyticsStatus').textContent=note(data);
      $('#hotCards').innerHTML=data.entries.length?data.entries.filter(e=>map.has(e.id)).map(e=>card(e,map.get(e.id),true)).join(''):'<p class="insight-empty">统计积累中。打开图片详情并停留至少 2 秒，开始记录真实浏览。</p>';
    }catch(e){if(seq===shelfSequence){$('#analyticsStatus').textContent=message(e);$('#hotCards').innerHTML='';}}
  }
  async function categories(){
    const all=await items(),source=$('#rankSource').value,old=$('#rankCategory').value;
    const values=[...new Set(all.filter(i=>!source||i.source===source).map(i=>i.category))].sort();
    $('#rankCategory').innerHTML='<option value="">全部分类</option>'+values.map(v=>`<option value="${escape(v)}">${escape(cats[v]||v)}</option>`).join('');
    if(values.includes(old))$('#rankCategory').value=old;
  }
  async function render(){
    const seq=++sequence;
    $('#insightNotice').textContent='正在读取统计…';$('#insightContent').innerHTML='';
    try{
      if(mode==='ranking'){
        const [data,all]=await Promise.all([request('/api/analytics/leaderboard?'+params({period,limit:60})),items()]);
        if(seq!==sequence)return;
        $('#insightNotice').textContent=note(data)+(period==='rising'?' 上升榜要求本周至少 20 次浏览，按较前 7 天增加量排序。':'');
        const map=new Map(all.map(i=>[i.id,i]));
        $('#insightContent').innerHTML=data.entries.length?'<div class="rank-grid">'+data.entries.filter(e=>map.has(e.id)).map(e=>card(e,map.get(e.id))).join('')+'</div>':'<div class="insight-empty">统计积累中，尚无满足此榜单条件的图片。</div>';
      }else{
        const data=await request('/api/analytics/trends?'+params());if(seq!==sequence)return;
        $('#insightNotice').textContent=note(data);
        const bars=(rows,field,title)=>`<section class="trend-breakdown"><h3>${title}</h3>${rows.length?rows.map(r=>`<button data-breakdown="${field}" data-value="${escape(r.value)}"><span>${escape(cats[r.value]||names[r.value]||r.value)}</span><b>${r.views} 次${r.previous!==undefined?` <small>较前 7 天 ${r.views-r.previous>=0?'+':''}${r.views-r.previous}</small>`:''}</b></button>`).join(''):'<p class="muted">统计积累中</p>'}</section>`;
        $('#insightContent').innerHTML=chart(data.daily,'最近 30 天浏览趋势')+'<div class="trend-columns">'+bars(data.category,'category','本周分类趋势')+bars(data.source,'source','本周来源趋势')+bars(data.angles,'angle','本周视角热度（逐图计数）')+'</div>';
      }
    }catch(e){if(seq===sequence){$('#insightNotice').textContent=message(e);$('#insightContent').innerHTML='<div class="insight-empty">统计不可用时，仍可从左侧进入图库浏览图片。</div>';}}
  }
  async function show(view){
    mode=view;
    $('#export').hidden=!!view;
    $('#galleryBrowser').hidden=!!view;$('#discovery').hidden=!view;$('#hotShelf').hidden=!!view;
    $('#discoveryTitle').textContent=view==='trends'?'趋势发现':'热门排行';
    $('#rankPeriods').hidden=view==='trends';
    document.querySelectorAll('[data-discovery]').forEach(b=>b.classList.toggle('active',b.dataset.discovery===view));
    if(view){await categories();await render();}
  }
  function visitor(){
    if(visitorMemory && visitorExpires>Date.now())return visitorMemory;
    let saved;
    try{saved=JSON.parse(localStorage.getItem('reference-library.analytics.visitor')||'null');}catch(_){}
    if(saved&&/^[a-f0-9]{32}$/.test(saved.token)&&saved.expires>Date.now())return saved.token;
    const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
    visitorMemory=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
    visitorExpires=Date.now()+86400000;
    try{localStorage.setItem('reference-library.analytics.visitor',JSON.stringify({token:visitorMemory,expires:visitorExpires}));}catch(_){}
    return visitorMemory;
  }
  async function event(kind,item){
    if(!item||optedOut||navigator.doNotTrack==='1')return;
    try{await request('/api/analytics/events',{kind,item_id:item.id,visitor:visitor(),...(kind==='view'?{dwell_ms:2000}:{})});}
    catch(_){ /* Analytics never interrupts browsing or downloads. */ }
  }
  function arm(){
    clearTimeout(timer);
    if(!active||document.hidden||!$('#detail').open)return;
    const item=active;
    timer=setTimeout(()=>{if(active===item&&!document.hidden&&$('#detail').open)event('view',item);},2000);
  }
  async function detail(item){
    active=item;arm();const seq=++detailSequence;
    const box=$('#detailAnalytics');box.innerHTML='<p class="muted">正在读取浏览统计…</p>';
    try{
      const [data,board,all]=await Promise.all([request('/api/analytics/item?'+new URLSearchParams({id:item.id})),
        request('/api/analytics/leaderboard?'+new URLSearchParams({period:'week',source:item.source,category:item.category,limit:10})),items()]);
      if(seq!==detailSequence||active?.id!==item.id)return;
      const map=new Map(all.map(i=>[i.id,i]));
      const recommendations=board.entries.filter(e=>e.group_id!==item.group_id&&map.has(e.id)).slice(0,4);
      box.innerHTML=`<div class="detail-counts"><span><b>${data.total_views}</b>累计浏览</span><span><b>${data.week_views}</b>本周浏览</span><span><b>${data.download_clicks}</b>下载点击</span></div><p class="muted">${data.week_category_rank?`本周${escape(cats[item.category]||item.category)}榜第 ${data.week_category_rank} 名 · `:''}同组累计 ${data.group_views} 次有效浏览 · 最多延迟 5 分钟</p>`+chart(data.daily,'最近 14 天')+(recommendations.length?'<h3>同分类热门参考</h3><div class="recommendations">'+recommendations.map(e=>card(e,map.get(e.id),true)).join('')+'</div>':'');
    }catch(e){if(seq===detailSequence)box.innerHTML=`<p class="muted">${escape(message(e))}</p>`;}
  }
  async function weights(sort){
    if(!['week','all'].includes(sort))return new Map();
    const data=await request('/api/analytics/leaderboard?'+new URLSearchParams({period:sort,limit:5000}));
    return new Map(data.entries.map(e=>[e.group_id,e.views]));
  }
  function init(api,openDetail){
    provider=api;open=openDetail;
    const detailBox=document.createElement('section');detailBox.id='detailAnalytics';$('#detailKeywords').after(detailBox);
    const click=async e=>{const b=e.target.closest('[data-insight-item]');if(b)try{if(!window.confirmDiscardDetail||window.confirmDiscardDetail())await open(b.dataset.insightItem);}catch(err){$('#analyticsStatus').textContent=message(err);}};
    for(const container of ['#hotCards','#insightContent','#detailAnalytics'])$(container).addEventListener('click',click);
    $('#showRanking').onclick=()=>$('#discoveryNav [data-discovery="ranking"]').click();
    $('#rankPeriods').onclick=e=>{const b=e.target.closest('[data-period]');if(!b)return;period=b.dataset.period;$('#rankPeriods').querySelectorAll('button').forEach(n=>n.setAttribute('aria-pressed',String(n===b)));render();};
    $('#rankSource').onchange=async()=>{try{await categories();await render();}catch(e){$('#insightNotice').textContent=message(e);}};
    $('#rankCategory').onchange=render;
    $('#reloadAnalytics').onclick=()=>{cache.clear();render();};
    $('#insightContent').addEventListener('click',e=>{const b=e.target.closest('[data-breakdown]');if(!b)return;window.dispatchEvent(new CustomEvent('gallery-filter',{detail:{field:b.dataset.breakdown,value:b.dataset.value}}));});
    $('#download').addEventListener('click',()=>{if($('#download').getAttribute('href'))event('download',active);});
    $('#detail').addEventListener('close',()=>{active=null;clearTimeout(timer);++detailSequence;});
    document.addEventListener('visibilitychange',arm);
    const trackingLabel=()=>$('#toggleTracking').textContent=optedOut?'开启我的匿名统计':'关闭我的匿名统计';
    trackingLabel();$('#toggleTracking').onclick=()=>{optedOut=!optedOut;try{localStorage.setItem('reference-library.analytics.off',optedOut?'1':'0');}catch(_){}trackingLabel();};
    shelf();
    setInterval(()=>{if(!document.hidden){shelf();if(mode)render();}},300000);
  }
  return {init,show,detail,weights,shelf};
})();
