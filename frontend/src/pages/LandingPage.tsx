/**
 * The public front page. Leads with what Sollux is first sold for —
 * monitoring a rental portfolio's bills and expenses alongside whatever the
 * owner already uses — and asks for a free portfolio audit (the form posts to
 * /api/public/audit-requests). Tenants and the books are shown as optional
 * modules. Shown at / to anyone signed out and at /welcome to anyone. Every
 * claim here is something the product does today; prices come from
 * backend/src/lib/plans.ts.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import Logo from '../components/brand/Logo';

const GOLD = '#F5A623';
const API = import.meta.env.VITE_API_URL || '/api';

const PLANS = [
  { name: 'Starter', price: 19, limit: 'Up to 3 properties' },
  { name: 'Pro', price: 49, limit: 'Up to 25 properties', featured: true },
  { name: 'Portfolio', price: 99, limit: 'Unlimited properties' },
];

/** The questions the bills side answers, each with what Sollux does about it. */
const QUESTIONS: { q: string; a: string }[] = [
  { q: 'Which bills never arrived?', a: 'Every account has a billing cycle. A month that doesn’t show up is flagged, instead of turning into a shut-off notice.' },
  { q: 'What went up, and why?', a: 'Each bill is read line by line and compared with its history: a water bill that doubles or a charge a provider has never billed before stands out.' },
  { q: 'Which fees could you have avoided?', a: 'Late fees, reinstatement, contamination and disconnection charges are pulled out of the totals and added up per property.' },
  { q: 'What’s due, and when?', a: 'Due dates, penalty dates, shut-off notices and the next insurance or loan installment, across every property, on one screen.' },
];

const BILL_POINTS = [
  'Statements fetched from each provider’s portal — or read from your email, a PDF or a photo',
  'Charges, past due, payment plans and fees each kept apart, so totals add up the way the provider’s do',
  'Payments applied as the provider applies them: fees first, then past due, then this month',
  'Insurance installments and loan payments tracked from their own statements',
];

/** Optional modules, each with a screenshot of the app on made-up demo data (public/landing). */
const MODULES: { tag: string; title: string; body: string; points: string[]; img: string; alt: string }[] = [
  {
    tag: 'Tenants & operations',
    title: 'Rent roll, rent collection and a tenant portal',
    body: 'See every lease, what it pays and who is behind. Tenants pay online and send repair requests through their own portal.',
    points: [
      'Rent by card (the tenant pays the card fee) or bank transfer (no fee to the tenant; Stripe’s 0.8%, at most $5, comes out of your payout) — Sollux takes no cut',
      'Autopay, arrears and late fees tracked for each lease',
      'Repairs, notices, legal and compliance in the same place',
    ],
    img: '/landing/tenants.jpg',
    alt: 'Rent roll with each lease’s rent, arrears and status',
  },
  {
    tag: 'Books & reporting',
    title: 'What each property earns and costs',
    body: 'Rent, bills, loans and insurance feed one set of books — the numbers are there at tax time.',
    points: [
      'P&L, NOI and cash flow by property, monthly or for the year',
      'Bank accounts synced nightly and reconciled against bills and rent',
    ],
    img: '/landing/money.jpg',
    alt: 'Income and cash flow by property with rental income, expenses and NOI',
  },
];

const STEPS = [
  { n: '1', title: 'Send a few bills', body: 'Upload or forward a handful of recent bills — no passwords needed to start.' },
  { n: '2', title: 'Get your audit', body: 'We go through them and tell you what’s missing, what went up and which fees were avoidable. If nothing’s wrong, we say so.' },
  { n: '3', title: 'Keep it running', body: 'Connect your portals and email, and Sollux keeps watching every bill as it posts.' },
];

const FAQ = [
  {
    q: 'Do I have to switch from AppFolio, Buildium or QuickBooks?',
    a: 'No. Sollux sits alongside what you use and watches the bills and expenses. Its tenant and accounting modules are there if you want them, not required.',
  },
  {
    q: 'What is the free portfolio audit?',
    a: 'Send a few recent bills. We read them with Sollux and send back what we find — missing bills, increases, avoidable fees, duplicate charges — in plain language. No card, no commitment.',
  },
  {
    q: 'Can Sollux pay bills or change my accounts?',
    a: 'No. It signs in only to read and download statements. It never pays, enrolls, changes settings or sends messages on a portal.',
  },
  {
    q: 'How are my logins kept?',
    a: 'Encrypted (AES-256-GCM) before they are stored, and never shown again. Bank and card numbers are kept as the last four digits only.',
  },
  {
    q: 'What if a provider blocks automated sign-ins?',
    a: 'Run the small Sollux connector on your own computer and fetches go through your own browser and internet. If a portal texts a code, Sollux asks you for it.',
  },
];

/** A stand-in of the app: one property's bills and what Sollux noticed, invented figures. */
function ProductPreview() {
  const rows = [
    { name: 'Electric', amount: '$184.22', status: 'Due Nov 4', tone: '#60a5fa' },
    { name: 'Water', amount: '$212.80', status: 'Up 96% on last year', tone: '#fbbf24' },
    { name: 'Trash', amount: '$72.10', status: '+$9.79 late fee', tone: '#f87171' },
    { name: 'Gas', amount: '—', status: 'October bill missing', tone: '#f87171' },
  ];
  return (
    <div className="rounded-2xl p-5 shadow-2xl" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-semibold text-white">Maple Street Duplex</p>
          <p className="text-xs text-gray-500">4 accounts · fetched this morning</p>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(245,166,35,0.12)', color: GOLD }}>3 things to look at</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {rows.map(r => (
          <div key={r.name} className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <p className="text-xs text-gray-400">{r.name}</p>
            <p className="text-sm font-semibold text-white">{r.amount}</p>
            <p className="text-xs" style={{ color: r.tone }}>{r.status}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-lg p-3 text-xs" style={{ background: 'rgba(245,166,35,0.08)', color: '#fbbf24' }}>
        This year: $214.63 in late and reinstatement fees across 5 properties.
      </div>
    </div>
  );
}

const fileToBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

/** The free portfolio audit request: saved for the owner of Sollux, who replies by email. */
function AuditForm() {
  const [f, setF] = useState({ name: '', email: '', phone: '', properties: '', currentTools: '', notes: '', website: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF(x => ({ ...x, [k]: e.target.value }));
  const input = 'w-full rounded-lg px-3 py-2 text-sm text-white bg-white/5 border border-white/10 focus:border-amber-500/50 outline-none';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (files.some(x => x.size > 10 * 1024 * 1024)) { setError('Each file must be under 10 MB.'); return; }
    setState('sending'); setError('');
    try {
      const encoded = await Promise.all(files.slice(0, 5).map(async x => ({ name: x.name, dataBase64: await fileToBase64(x) })));
      await axios.post(`${API}/public/audit-requests`, { ...f, properties: f.properties || null, files: encoded });
      setState('sent');
    } catch (err: any) {
      setState('error');
      setError(err?.response?.status === 429 ? 'Too many requests from here — try again in an hour.' : err?.response?.data?.error ?? 'Could not send. Please try again.');
    }
  }

  if (state === 'sent') return (
    <div className="rounded-2xl p-8 text-center" style={{ background: '#1b1b1b', border: `1px solid ${GOLD}` }}>
      <p className="text-lg font-semibold text-white">Thanks — your request is in.</p>
      <p className="mt-2 text-sm text-gray-400">We’ll email {f.email}{files.length ? ' with what we find in your bills' : ' to get a few bills from you'}.</p>
    </div>
  );

  return (
    <form onSubmit={submit} className="rounded-2xl p-6 space-y-4" style={{ background: '#1b1b1b', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block"><span className="text-xs text-gray-400">Name</span><input required className={`${input} mt-1`} value={f.name} onChange={set('name')} /></label>
        <label className="block"><span className="text-xs text-gray-400">Email</span><input required type="email" className={`${input} mt-1`} value={f.email} onChange={set('email')} /></label>
        <label className="block"><span className="text-xs text-gray-400">Phone (optional)</span><input className={`${input} mt-1`} value={f.phone} onChange={set('phone')} /></label>
        <label className="block"><span className="text-xs text-gray-400">How many properties?</span><input type="number" min={0} className={`${input} mt-1`} value={f.properties} onChange={set('properties')} /></label>
      </div>
      <label className="block"><span className="text-xs text-gray-400">What do you use today?</span>
        <select className={`${input} mt-1`} value={f.currentTools} onChange={set('currentTools')}>
          <option value="">Choose one</option>
          {['Spreadsheets and email', 'AppFolio', 'Buildium', 'QuickBooks', 'A property manager', 'Something else'].map(o => <option key={o}>{o}</option>)}
        </select>
      </label>
      <label className="block"><span className="text-xs text-gray-400">Anything we should know? (optional)</span>
        <textarea rows={3} className={`${input} mt-1`} value={f.notes} onChange={set('notes')} placeholder="The bills that bother you most, providers you use, states you own in…" /></label>
      <label className="block"><span className="text-xs text-gray-400">A few recent bills (optional · up to 5 PDFs or photos, 10 MB each)</span>
        <input type="file" multiple accept="application/pdf,image/*" className="mt-1 block w-full text-xs text-gray-400 file:mr-3 file:rounded-lg file:border-0 file:px-3 file:py-1.5 file:text-black file:bg-[#F5A623]" onChange={e => setFiles(Array.from(e.target.files ?? []).slice(0, 5))} />
      </label>
      {/* People leave this empty; form-filling bots do not. */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} className="hidden" aria-hidden="true" />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button type="submit" disabled={state === 'sending'} className="w-full rounded-lg px-5 py-2.5 font-medium text-black disabled:opacity-60" style={{ background: GOLD }}>
        {state === 'sending' ? 'Sending…' : 'Request my free audit'}
      </button>
      <p className="text-xs text-gray-500 text-center">Your bills are stored privately and used only for your audit.</p>
    </form>
  );
}

export default function LandingPage() {
  const line = { borderTop: '1px solid rgba(255,255,255,0.06)' };
  return (
    <div className="min-h-screen" style={{ background: '#141414', color: '#d1d5db' }}>
      {/* Header */}
      <header className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex items-center justify-between">
        <Logo size={30} />
        <nav className="flex items-center gap-4 text-sm">
          <a href="#pricing" className="hidden sm:inline text-gray-400 hover:text-white">Pricing</a>
          <a href="#faq" className="hidden sm:inline text-gray-400 hover:text-white">FAQ</a>
          <Link to="/sign-in" className="text-gray-300 hover:text-white">Sign in</Link>
          <a href="#audit" className="rounded-lg px-3.5 py-1.5 font-medium text-black" style={{ background: GOLD }}>Free audit</a>
        </nav>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-10 pb-16 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: GOLD }}>For rental property owners</p>
          <h1 className="text-4xl sm:text-5xl font-semibold text-white leading-tight tracking-tight">
            Never lose track of another property expense.
          </h1>
          <p className="mt-5 text-base text-gray-400 max-w-xl">
            Sollux gathers the bills for every property, catches unusual charges and avoidable fees, and watches every
            due date — so you see where the money goes across your portfolio before a late fee or a shut-off notice tells you.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a href="#audit" className="rounded-lg px-5 py-2.5 font-medium text-black" style={{ background: GOLD }}>Get a free portfolio audit</a>
            <Link to="/sign-up" className="rounded-lg px-5 py-2.5 font-medium text-gray-200" style={{ border: '1px solid rgba(255,255,255,0.15)' }}>or start a free trial</Link>
          </div>
          <p className="mt-3 text-xs text-gray-500">Works alongside AppFolio, Buildium, QuickBooks or your spreadsheets.</p>
        </div>
        <ProductPreview />
      </section>

      {/* Bills & expenses — the main event */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-16" style={line}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: GOLD }}>Bills & expenses</p>
        <h2 className="text-2xl sm:text-3xl font-semibold text-white max-w-2xl">The questions a spreadsheet can’t answer on its own</h2>
        <div className="mt-8 grid sm:grid-cols-2 gap-4">
          {QUESTIONS.map(x => (
            <div key={x.q} className="rounded-2xl p-5" style={{ background: '#1b1b1b', border: '1px solid rgba(255,255,255,0.06)' }}>
              <h3 className="text-base font-semibold text-white">{x.q}</h3>
              <p className="mt-2 text-sm text-gray-400 leading-relaxed">{x.a}</p>
            </div>
          ))}
        </div>
        <div className="mt-12 grid lg:grid-cols-5 gap-10 items-center">
          <div className="lg:col-span-2">
            <h3 className="text-xl font-semibold text-white">Every bill fetched and read for you</h3>
            <ul className="mt-5 space-y-2.5">
              {BILL_POINTS.map(pt => (
                <li key={pt} className="flex gap-2.5 text-sm text-gray-300">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: GOLD }} />{pt}
                </li>
              ))}
            </ul>
          </div>
          <div className="lg:col-span-3">
            <img src="/landing/bills.jpg" alt="Properties with each utility account’s amount due and status" loading="lazy"
              className="w-full rounded-2xl shadow-2xl" style={{ border: '1px solid rgba(255,255,255,0.08)' }} />
          </div>
        </div>
      </section>

      {/* How the audit works */}
      <section id="how" className="max-w-6xl mx-auto px-4 sm:px-6 py-16" style={line}>
        <h2 className="text-2xl sm:text-3xl font-semibold text-white">Start with a free audit</h2>
        <div className="mt-10 grid md:grid-cols-3 gap-6">
          {STEPS.map(s => (
            <div key={s.n}>
              <span className="inline-flex w-9 h-9 items-center justify-center rounded-full text-sm font-semibold text-black" style={{ background: GOLD }}>{s.n}</span>
              <h3 className="mt-4 text-base font-semibold text-white">{s.title}</h3>
              <p className="mt-2 text-sm text-gray-400">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* The audit request */}
      <section id="audit" className="max-w-3xl mx-auto px-4 sm:px-6 py-16" style={line}>
        <h2 className="text-2xl sm:text-3xl font-semibold text-white">Get a free portfolio audit</h2>
        <p className="mt-3 mb-8 text-gray-400">Tell us a little about your portfolio and attach a few bills. We’ll reply by email with what we find.</p>
        <AuditForm />
      </section>

      {/* Optional modules */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-16" style={line}>
        <h2 className="text-2xl sm:text-3xl font-semibold text-white">Also included, when you want it</h2>
        <p className="mt-3 text-gray-400 max-w-2xl">Turn these on in Settings — every plan includes them. Keep using your current tools for the rest if you prefer.</p>
        <div className="mt-10 grid lg:grid-cols-2 gap-6">
          {MODULES.map(m => (
            <div key={m.tag} className="rounded-2xl p-5 flex flex-col" style={{ background: '#1b1b1b', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: GOLD }}>{m.tag}</p>
              <h3 className="mt-2 text-lg font-semibold text-white">{m.title}</h3>
              <p className="mt-2 text-sm text-gray-400">{m.body}</p>
              <ul className="mt-4 space-y-2 flex-1">
                {m.points.map(pt => (
                  <li key={pt} className="flex gap-2.5 text-sm text-gray-300">
                    <span className="mt-2 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: GOLD }} />{pt}
                  </li>
                ))}
              </ul>
              <img src={m.img} alt={m.alt} loading="lazy" className="mt-5 w-full rounded-xl" style={{ border: '1px solid rgba(255,255,255,0.08)' }} />
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-6xl mx-auto px-4 sm:px-6 py-16" style={line}>
        <h2 className="text-2xl sm:text-3xl font-semibold text-white">Simple pricing</h2>
        <p className="mt-3 text-gray-400">Every plan has everything. Pick by how many properties you own.</p>
        <div className="mt-10 grid md:grid-cols-3 gap-4">
          {PLANS.map(p => (
            <div key={p.name} className="rounded-2xl p-6 flex flex-col"
              style={{ background: '#1b1b1b', border: p.featured ? `1px solid ${GOLD}` : '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-white">{p.name}</h3>
                {p.featured && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(245,166,35,0.12)', color: GOLD }}>Most popular</span>}
              </div>
              <p className="mt-4"><span className="text-4xl font-semibold text-white">${p.price}</span><span className="text-gray-500"> /month</span></p>
              <p className="mt-2 text-sm text-gray-400">{p.limit}</p>
              <Link to="/sign-up" className="mt-6 rounded-lg px-4 py-2 text-center text-sm font-medium"
                style={p.featured ? { background: GOLD, color: '#000' } : { border: '1px solid rgba(255,255,255,0.15)', color: '#e5e7eb' }}>
                Start free trial
              </Link>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-gray-500">14-day free trial, no card needed. Rent collection has no Sollux fee: card fees are paid by the tenant; bank transfers cost the tenant nothing and Stripe’s 0.8% (at most $5) comes out of your payout.</p>
      </section>

      {/* FAQ */}
      <section id="faq" className="max-w-3xl mx-auto px-4 sm:px-6 py-16" style={line}>
        <h2 className="text-2xl sm:text-3xl font-semibold text-white">Questions</h2>
        <div className="mt-8 space-y-3">
          {FAQ.map(f => (
            <details key={f.q} className="rounded-xl px-5 py-4 group" style={{ background: '#1b1b1b', border: '1px solid rgba(255,255,255,0.06)' }}>
              <summary className="cursor-pointer list-none flex items-center justify-between text-sm font-medium text-white">
                {f.q}
                <span className="text-gray-500 group-open:rotate-45 transition-transform text-lg leading-none">+</span>
              </summary>
              <p className="mt-3 text-sm text-gray-400 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* Closing call */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-20">
        <div className="rounded-2xl px-6 py-12 text-center" style={{ background: 'linear-gradient(135deg, rgba(245,166,35,0.14), rgba(245,166,35,0.04))', border: '1px solid rgba(245,166,35,0.25)' }}>
          <h2 className="text-2xl sm:text-3xl font-semibold text-white">See what your bills aren’t telling you</h2>
          <p className="mt-3 text-gray-400">Send a few bills and get a free audit — or start a 14-day trial and connect them yourself.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a href="#audit" className="rounded-lg px-6 py-2.5 font-medium text-black" style={{ background: GOLD }}>Get a free audit</a>
            <Link to="/sign-up" className="rounded-lg px-6 py-2.5 font-medium text-gray-200" style={{ border: '1px solid rgba(255,255,255,0.15)' }}>Start a free trial</Link>
          </div>
        </div>
      </section>

      <footer className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500" style={line}>
        <span>© {new Date().getFullYear()} Sollux</span>
        <span className="flex gap-4">
          <Link to="/privacy" className="hover:text-gray-300">Privacy</Link>
          <Link to="/terms" className="hover:text-gray-300">Terms</Link>
          <Link to="/sign-in" className="hover:text-gray-300">Sign in</Link>
        </span>
      </footer>
    </div>
  );
}
