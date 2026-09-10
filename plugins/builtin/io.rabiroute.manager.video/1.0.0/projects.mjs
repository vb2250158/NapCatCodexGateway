import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {VideoError} from './service.mjs';

export class VideoProjects {
  constructor(runtime) { this.runtime=runtime; this.root=path.join(runtime.stateRoot,'projects'); this.serial=Promise.resolve(); }
  file(id) { if(!/^[a-f0-9-]{36}$/.test(id)) throw new VideoError('项目不存在。',404); return path.join(this.root,`${id}.json`); }
  async read(id) {
    try { return JSON.parse(await fs.readFile(this.file(id),'utf8')); }
    catch(error) { if(error.code==='ENOENT') throw new VideoError('项目不存在。',404); throw error; }
  }
  async list() {
    const names=await fs.readdir(this.root).catch(error=>{if(error.code==='ENOENT') return [];throw error;});
    const projects=await Promise.all(names.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).map(name=>this.read(name.slice(0,-5))));
    return projects.map(({id,title,updatedAt,revision,value})=>({id,title,updatedAt,revision,cardCount:value?.items?.length || 0})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
  mutate(operation) {
    if(this.runtime.readOnly) throw new VideoError('当前服务只读，无法保存项目。',423);
    const next=this.serial.then(operation);this.serial=next.catch(()=>{});return next;
  }
  async publish(project) {
    await fs.mkdir(this.root,{recursive:true});
    const target=this.file(project.id), temp=`${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp,JSON.stringify(project),{flag:'wx'});
    await fs.rename(temp,target);return project;
  }
  create(body) { return this.mutate(async()=>{
    this.file(body?.id);
    const existing=await this.read(body.id).catch(error=>{if(error.status===404) return undefined;throw error;});
    if(existing) return existing;
    return this.publish({id:body.id,title:'未命名项目',revision:0,updatedAt:new Date().toISOString(),value:null});
  }); }
  save(id,body) { return this.mutate(async()=>{
    const previous=await this.read(id);
    if(!Number.isSafeInteger(body?.revision)||body.revision!==previous.revision) throw new VideoError('项目已被另一页面更新，请保留当前编辑后重新打开项目。',409);
    const value=body.value;
    if(value?.version!==1 || !Array.isArray(value.items) || value.items.length>1000 || !Array.isArray(value.drafts) || !value.items.some(item=>item.id===value.active && item.kind==='video')) throw new VideoError('项目内容无效。');
    if(value.items.some(item=>!item || typeof item.id!=='string' || !['video','image','audio','text'].includes(item.kind)) || new Set(value.items.map(item=>item.id)).size!==value.items.length) throw new VideoError('项目卡片无效。');
    const title=typeof body.title==='string'?body.title.trim().slice(0,100):previous.title;
    return this.publish({id,title:title||'未命名项目',revision:previous.revision+1,updatedAt:new Date().toISOString(),value});
  }); }
}

export async function handleProjects(store,request,url,response,http) {
  const route=url.pathname.slice('/api/video'.length);
  const match=/^\/projects\/([a-f0-9-]{36})$/.exec(route);
  if(route!=='/projects'&&!match) return false;
  response.setHeader('cache-control','no-store');
  let value;
  if(route==='/projects'&&request.method==='GET') value={projects:await store.list()};
  else if(route==='/projects'&&request.method==='POST') value=await store.create(await http.readJsonBody(request,4096));
  else if(match&&request.method==='GET') value=await store.read(match[1]);
  else if(match&&request.method==='PUT') { const saved=await store.save(match[1],await http.readJsonBody(request,64*1024*1024));value={revision:saved.revision}; }
  else throw new VideoError('不支持此项目操作。',405);
  http.jsonResponse(response,200,value);return true;
}
