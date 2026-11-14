import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../server.js';
import { connect } from '../src/connection.js';
test('five devices, private transfers, names, concurrency and removal', { timeout: 15000 }, async t => {
 const relay = createRelay(); await new Promise(r => relay.http.listen(0,'127.0.0.1',r));
 const clients=[]; t.after(async()=>{clients.forEach(d=>d.c.destroy());await new Promise(r=>relay.io.close(r));});
 const make=()=>{const d={files:new Map(),notes:[],members:[]};d.c=connect({online(){},paired(){},mode(){},error(){},ended(){d.ended=true},members(m){d.members=m},message(m){d.notes.push(m)},file(f){d.files.set(f.id,{...d.files.get(f.id),...f})}},`http://127.0.0.1:${relay.http.address().port}`);clients.push(d);return d;};
 const host=make();const room=await host.c.enter();const guests=[];
 for(let i=0;i<4;i++){const d=make();d.room=await d.c.enter(room.code,i===0?'John':'');guests.push(d);}
 const sixth=make();await assert.rejects(sixth.c.enter(room.code),/full/);
 const bytes=Uint8Array.from({length:100000},(_,i)=>i%256);
 await Promise.all(guests.map((d,i)=>d.c.sendFile(new File([bytes],`file${i}.bin`))));
 assert.equal(host.files.size,4);for(const f of host.files.values()){assert.equal(f.done,true);assert.deepEqual(new Uint8Array(await(await fetch(f.url)).arrayBuffer()),bytes);assert.ok(f.sender);}
 assert.equal([...host.files.values()].find(f=>f.name==='file0.bin').sender,'John');
 assert.equal(guests[1].files.size,1);
 await guests[0].c.chat('private');assert.equal(host.notes[0].sender,'John');assert.equal(guests[1].notes.length,0);
 host.c.selectRecipient(guests[0].room.memberId);await host.c.chat('reply');assert.equal(guests[0].notes[0].text,'reply');assert.equal(guests[1].notes.length,0);
 await assert.rejects(guests[1].c.kick(guests[0].room.memberId),/host/);
 await host.c.kick(guests[0].room.memberId);await new Promise(r=>setTimeout(r,30));assert.ok(guests[0].ended);
 const replacement=await sixth.c.enter(room.code);assert.ok(replacement.members.some(m=>m.name==='Guest 5'));
 await host.c.end();
});
