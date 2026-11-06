"use strict";
// Two tenants, one immutable client mutation ID per tenant, finite schedules.
const init={commits:[0,0],acked:[0,0],cursor:[0,0],lost:false,retried:false,crossDenied:false,futureDenied:false,cancelled:false,committed:false};
function must(v,m){if(!v)throw Error("opto sync model: "+m);}
function valid(s){
 for(let t=0;t<2;t++){
  must(s.commits[t]===0||s.commits[t]===1,"a mutation applied more than once");
  must(s.acked[t]<=s.commits[t],"ack without durable commit");
  must(s.cursor[t]<=s.commits[t],"cursor ahead of committed watermark");
 }
}
function next(s){
 const out=[];
 for(let t=0;t<2;t++){
  const set=(key,value)=>({...s,[key]:s[key].map((v,i)=>i===t?value:v)});
  if(s.commits[t]===0)out.push(["durable-commit-"+t,{...set("commits",1),committed:true}]);
  if(s.commits[t]===1){
   if(s.acked[t]===0)out.push(["ack-committed-"+t,set("acked",1)]);
   if(s.cursor[t]===0)out.push(["advance-cursor-"+t,set("cursor",1)]);
   out.push(["same-ID-retry-"+t,{...s,retried:true}]);
   out.push(["lost-response-"+t,{...s,lost:true}]);
   out.push(["cancel-after-commit-"+t,{...s,cancelled:true}]);
  }
  // Cross-tenant credentials and future watermarks have no write transition.
  if(!s.crossDenied)out.push(["reject-cross-tenant-"+t,{...s,crossDenied:true}]);
  if(!s.futureDenied)out.push(["reject-future-cursor-"+t,{...s,futureDenied:true}]);
 }
 return out;
}
function explore(){
 const BOUND=10,seen=new Set([JSON.stringify(init)]),queue=[[init,0]],events={};
 let edges=0;
 for(let i=0;i<queue.length;i++){
  const [s,d]=queue[i];valid(s);if(d===BOUND)continue;
  for(const [e,t]of next(s)){
   valid(t);edges++;events[e.split("-")[0]]=true;
   const k=JSON.stringify(t);
   if(!seen.has(k)){seen.add(k);queue.push([t,d+1]);}
  }
 }
 const states=[...seen].map(JSON.parse);
 for(const f of ["committed","retried","crossDenied","futureDenied","cancelled","lost"])
  must(states.some(s=>s[f]),"missing witness: "+f);
 for(const bad of [
  {...init,commits:[2,0]},
  {...init,acked:[1,0]},
  {...init,cursor:[0,1]}
 ]){
  let rejected=false;try{valid(bad);}catch{rejected=true;}
  must(rejected,"unsafe mutation was not caught");
 }
 return {states:seen.size,transitions:edges,tenants:2,mutationIdsPerTenant:1,bound:BOUND,claim:"finite source-only; no DB/client replay"};
}
const result=explore();
if(typeof console!=="undefined")console.log(JSON.stringify(result));
