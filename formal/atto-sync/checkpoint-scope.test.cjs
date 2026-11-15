// Independent HOST-ONLY model of the experimental .atto checkpoint contract.
// The source below is not compiled or executed by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const MAX = (1n<<63n)-1n;
const resume=(active,observed,local,claimed,scope,durable)=>
  active>0n && active===observed && local>=0n &&
  claimed===local && scope && durable;
const change=(active,observed,local,previous,next,scope,authoritative)=>
  active>0n && active===observed && local>=0n &&
  previous===local && next>previous && next<=MAX &&
  scope && authoritative;
const rotate=(oldGen,newGen,reset,scope,durable)=>
  oldGen>0n && oldGen<MAX && newGen>oldGen &&
  newGen<=MAX && reset===0n && scope && durable;

test('the AttoLang checkpoint candidate is a source-level reference only',()=>{
  const source=readFileSync(join(__dirname,'checkpoint_policy.atto'),'utf8');
  for(const anchor of [
    'define pub module checkpoint_policy',
    'pub fnc valid_resume(', 'pub fnc valid_change(',
    'pub fnc valid_rotation(', 'previous_checkpoint == local_checkpoint',
    'reset_checkpoint == 0', 'new_generation > old_generation'
  ]) assert.ok(source.includes(anchor),anchor);
});

test('checkpoint replay and cross-tenant/stale-generation admission fail closed',()=>{
  let admitted=0,declined=0;
  for(let active=0n;active<=3n;active++)
    for(let observed=0n;observed<=3n;observed++)
      for(let local=0n;local<=4n;local++)
        for(let previous=0n;previous<=4n;previous++)
          for(let next=0n;next<=6n;next++)
            for(const scope of [false,true])
              for(const authoritative of [false,true]) {
                const ok=change(active,observed,local,previous,next,scope,authoritative);
                if(ok) {
                  admitted++;
                  assert.ok(active>0n&&active===observed&&scope&&authoritative);
                  assert.ok(next>local&&previous===local);
                } else declined++;
              }
  assert.ok(admitted>0&&declined>admitted);
  assert.ok(change(3n,3n,4n,4n,6n,true,true),
    'filtered tenant stream can skip unrelated server revisions');
  assert.equal(change(3n,3n,4n,4n,6n,false,true),false);
  assert.equal(change(3n,2n,4n,4n,6n,true,true),false);
  assert.equal(change(3n,3n,4n,3n,6n,true,true),false);
  assert.equal(change(3n,3n,MAX,MAX,MAX+1n,true,true),false);
});

test('snapshot resume cannot manufacture durability or transplant an old cursor',()=>{
  assert.ok(resume(2n,2n,10n,10n,true,true));
  assert.equal(resume(2n,2n,10n,11n,true,true),false);
  assert.equal(resume(2n,1n,10n,10n,true,true),false);
  assert.equal(resume(2n,2n,10n,10n,false,true),false);
  assert.equal(resume(2n,2n,10n,10n,true,false),false);
  assert.ok(rotate(2n,3n,0n,true,true));
  assert.equal(rotate(2n,3n,10n,true,true),false);
  assert.equal(rotate(2n,2n,0n,true,true),false);
  assert.equal(rotate(2n,3n,0n,false,true),false);
  assert.equal(rotate(MAX,MAX+1n,0n,true,true),false);
});
