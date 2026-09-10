export type AudioPromptPart={kind:"text";text:string}|{kind:"pause";seconds:number}|{kind:"cue";text:string};
export function splitAudioPrompt(text:string):AudioPromptPart[] {
  const parts:AudioPromptPart[]=[];const tags=/<#(0\.5|1|2)#>|<\[(嗯|啊|哦|唉)\]>/g;let start=0;
  for(const match of text.matchAll(tags)) {if(match.index!>start)parts.push({kind:"text",text:text.slice(start,match.index)});parts.push(match[1] ? {kind:"pause",seconds:Number(match[1])} : {kind:"cue",text:match[2]!});start=match.index!+match[0].length;}
  if(start<text.length)parts.push({kind:"text",text:text.slice(start)});return parts;
}
export function encodeAudioWithPauses(parts:(Float32Array|number)[],sampleRate=48000):Blob {
  const size=parts.reduce<number>((total,part)=>total+(typeof part==="number" ? Math.round(part*sampleRate) : part.length),0);
  if(!size || size>sampleRate*300)throw new Error("合成音频须在 5 分钟以内。");
  const buffer=new ArrayBuffer(44+size*2),view=new DataView(buffer);
  const label=(offset:number,text:string)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
  label(0,"RIFF");view.setUint32(4,36+size*2,true);label(8,"WAVE");label(12,"fmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);label(36,"data");view.setUint32(40,size*2,true);
  let offset=44;
  for(const part of parts){if(typeof part==="number"){offset+=Math.round(part*sampleRate)*2;continue;}for(const value of part){const sample=Math.max(-1,Math.min(1,value));view.setInt16(offset,Math.round(sample*(sample<0?32768:32767)),true);offset+=2;}}
  return new Blob([buffer],{type:"audio/wav"});
}
export async function synthesizeWithPauses(text:string,synthesize:(text:string)=>Promise<Blob>):Promise<Blob> {
  if(text.length>10000)throw new Error("合成文字最多 10000 字符。");
  const parts=splitAudioPrompt(text);
  if(!parts.some(part=>part.kind==="pause"))return synthesize(parts.map(part=>part.kind==="pause" ? "" : part.text).join(""));
  if(parts.filter(part=>part.kind==="pause").length>50)throw new Error("每次最多添加 50 个停顿。");
  const context=new AudioContext({sampleRate:48000});
  try {
    const samples:(Float32Array|number)[]=[];let duration=0;
    for(const part of parts) {
      if(part.kind==="pause"){samples.push(part.seconds);duration+=part.seconds;}
      else if(part.text.trim()) {
        const audio=await context.decodeAudioData(await (await synthesize(part.text)).arrayBuffer());
        duration+=audio.duration;if(duration>300)throw new Error("合成音频须在 5 分钟以内。");
        const mono=new Float32Array(audio.length);
        for(let channel=0;channel<audio.numberOfChannels;channel++){const data=audio.getChannelData(channel);for(let i=0;i<data.length;i++)mono[i]!+=data[i]!/audio.numberOfChannels;}
        samples.push(mono);
      }
    }
    return encodeAudioWithPauses(samples,context.sampleRate);
  } finally {await context.close();}
}
