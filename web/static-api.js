'use strict';
// Static deployment: published catalogue + per-browser annotations. No server API.
window.StaticLibrary = (() => {
  const key = 'reference-library.annotations.v1';
  let edits = {};
  try { edits = JSON.parse(localStorage.getItem(key) || '{}'); } catch (_) { /* malformed local storage */ }
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) edits = {};
  const ready = fetch('./catalog.json?v=20261031-cors', {cache:'no-store'}).then(async r => {
    if (!r.ok) throw new Error('无法读取静态图片清单，请检查部署文件');
    const data = await r.json();
    if (!Array.isArray(data.items)) throw new Error('图片清单格式错误');
    return data.items;
  });
  const withEdits = item => ({...item, favorite:false, tags:[], note:'', trashed:false, ...(edits[item.id] || {})});
  function filtered(items, q) {
    return items.map(withEdits).filter(i => {
      if (i.trashed !== (q.get('trash') === '1')) return false;
      for (const field of ['source','category','system','angle','group_id']) if (q.get(field) && i[field] !== q.get(field)) return false;
      if (q.get('favorite') === '1' && !i.favorite) return false;
      if (q.get('tag') && !i.tags.includes(q.get('tag'))) return false;
      const status=q.get('state');
      if (status==='downloaded' && !i.original) return false;
      if (status==='failed' && !i.assets.some(a=>a.status==='failed')) return false;
      if (status==='pending' && !i.assets.some(a=>a.status==='pending')) return false;
      const search=[i.title,i.remote_id,i.category,i.system,i.angle,i.keywords,...i.tags,i.note].join(' ').toLowerCase();
      return (q.get('q')||'').toLowerCase().split(/\s+/).filter(Boolean).every(w=>search.includes(w));
    });
  }
  async function request(path, body) {
    const items=await ready, url=new URL(path, location.origin), q=url.searchParams;
    if (url.pathname==='/api/edit') {
      if (!body || !Array.isArray(body.ids) || !body.changes) throw new Error('无效修改');
      const allowed=new Set(items.map(i=>i.id));
      const next={...edits};
      for (const id of body.ids) {
        if (!allowed.has(id)) continue;
        const changes={};
        for (const [k,v] of Object.entries(body.changes)) {
          if (k==='tags') {
            if (!Array.isArray(v)||v.length>30||v.some(t=>typeof t!=='string'||t.length>50)) throw new Error('最多 30 个标签，每个最多 50 字');
            changes.tags=[...new Set(v.map(t=>t.trim()).filter(Boolean))];
          } else if ((k==='favorite'||k==='trashed') && typeof v==='boolean') changes[k]=v;
          else if (k==='note' && typeof v==='string' && v.length<=10000) changes.note=v;
          else throw new Error('无效修改字段');
        }
        next[id]={...(next[id]||{}),...changes};
      }
      try { localStorage.setItem(key,JSON.stringify(next)); } catch (_) { throw new Error('浏览器存储不可用或已满，修改未保存'); }
      edits=next;return {ok:true};
    }
    if (url.pathname==='/api/items' || url.pathname==='/api/export') {
      const list=filtered(items,q), page=Math.max(1,Number(q.get('page'))||1);
      if(['week','all'].includes(q.get('sort'))){
        const weights=await window.GalleryAnalytics.weights(q.get('sort'));
        list.sort((a,b)=>(weights.get(b.group_id)||0)-(weights.get(a.group_id)||0)||a.id.localeCompare(b.id));
      }
      return url.pathname==='/api/export' ? {version:1,items:list} : {items:list.slice((page-1)*60,page*60),total:list.length,page,pages:Math.ceil(list.length/60)};
    }
    if (url.pathname.startsWith('/api/item/')) {
      const id=decodeURIComponent(url.pathname.slice('/api/item/'.length));
      const item=items.find(i=>i.id===id);
      if (!item) throw new Error('图片不存在');
      return {...withEdits(item),siblings:items.filter(i=>i.group_id===item.group_id && !withEdits(i).trashed).map(withEdits)};
    }
    if (url.pathname==='/api/stats') {
      const all=items.map(withEdits), visible=all.filter(i=>!i.trashed), sizes=new Map();
      all.forEach(i=>i.assets.forEach(a=>{if(a.path&&a.size)sizes.set(a.path,a.size);}));
      const result={total:all.length,favorites:all.filter(i=>i.favorite).length,trashed:all.length-visible.length,
        downloaded:all.filter(i=>i.original).length,failed:0,bytes:[...sizes.values()].reduce((a,b)=>a+b,0),runs:[]};
      for (const field of ['source','category','system','angle']) {
        const counts=new Map();visible.forEach(i=>{if(i[field])counts.set(i[field],(counts.get(i[field])||0)+1);});
        result[field]=[...counts].sort((a,b)=>a[0].localeCompare(b[0],'zh-CN')).map(([value,count])=>({value,count}));
      }
      const tags=new Map();visible.forEach(i=>i.tags.forEach(t=>tags.set(t,(tags.get(t)||0)+1)));
      result.tags=[...tags].map(([value,count])=>({value,count}));return result;
    }
    throw new Error('静态站不支持在线采集，请在本地采集后重新发布');
  }
  return {request};
})();
