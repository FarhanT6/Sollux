/** Signed in with their own login on the owner's account, a person is "Me": matched by name, then by the login linked to them. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, skip, OWNER, type TestApi } from './server';

let api: TestApi;
const ids: Record<string, string> = {};

before(async () => {
  if (skip) return;
  api = await startApi();
  const { db } = api;
  const owner = await db.user.create({ data: { clerkUserId: 'user_owner_x', email: 'boss@example.com', fullName: 'Jordan Lee', trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } as any });
  // The test's own sign-in is a family login on that account.
  const me = await db.user.create({ data: { ...OWNER, ownerUserId: owner.id, trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } as any });
  ids.owner = owner.id; ids.me = me.id;
  ids.sib = (await db.householdMember.create({ data: { userId: owner.id, name: 'Alex Morgan (brother)' } })).id;
  ids.other = (await db.householdMember.create({ data: { userId: owner.id, name: 'Sam' } })).id;
});
after(async () => { if (!skip) await api.stop(); });

test('the signed-in person is matched by name, and a linked login wins', { skip }, async () => {
  let h = await (await fetch(`${api.url}/api/household`)).json() as any;
  assert.equal(h.viewerIsOwner, false);
  assert.equal(h.viewerMemberId, ids.sib);
  assert.equal(h.ownerName, 'Jordan Lee');
  assert.deepEqual(h.logins, [], 'only the owner sees the logins to link');

  await api.db.householdMember.update({ where: { id: ids.other }, data: { loginUserId: ids.me } });
  h = await (await fetch(`${api.url}/api/household`)).json() as any;
  assert.equal(h.viewerMemberId, ids.other);

  const r = await fetch(`${api.url}/api/household/${ids.sib}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginUserId: ids.me }) });
  assert.equal(r.status, 403, 'a family login cannot link logins');
});
