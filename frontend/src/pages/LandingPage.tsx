/**
 * The public front page: what Sollux does — bills, tenants and leases, money
 * and reporting — what it costs, and the way in.
 * Shown at / to anyone signed out (signed in, / is the dashboard) and at
 * /welcome to anyone. Every claim here is something the product does today;
 * prices come from backend/src/lib/plans.ts.
 */
import { Link } from 'react-router-dom';
import Logo from '../components/brand/Logo';

const GOLD = '#F5A623';

const PLANS = [
  { name: 'Starter', price: 19, limit: 'Up to 3 properties' },
  { name: 'Pro', price: 49, limit: 'Up to 25 properties', featured: true },
  { name: 'Portfolio', price: 99, limit: 'Unlimited properties' },
];

/** The three things Sollux runs, each with a screenshot of the app on demo data (public/landing). */
const PILLARS: { tag: string; title: string; body: string; points: string[]; img: string; alt: string }[] = [
  {
    tag: 'Bills & utilities',
    title: 'Every bill fetched, read and tracked',
    body: 'Sollux signs in to each provider’s portal — electric, gas, water, trash, internet, insurance, lenders — and files every statement as it posts. No portal? It reads the bill from your email or a photo.',
    points: [
      'Charges, past due, payment plans and fees each kept apart',
      'Late, reinstatement and contamination fees totalled per property',
      'Payments applied the way the provider does: fees, past due, then this month',
    ],
    img: '/landing/bills.jpg',
    alt: 'Properties with each utility account’s amount due and status',
  },
  {
    tag: 'Tenants & leases',
    title: 'Rent roll, rent collection and a tenant portal',
    body: 'See every lease, what it pays and who is behind. Tenants pay online and send repair requests through their own portal.',
    points: [
      'Rent by bank transfer free, by card with the fee on the tenant — no Sollux cut',
      'Autopay, arrears and late fees tracked for each lease',
      'Scheduled rent increases and month-to-month rollovers applied on their date',
      'Repair requests and 3-day notices in the same place',
    ],
    img: '/landing/tenants.jpg',
    alt: 'Rent roll with each lease’s rent, arrears and status',
  },
  {
    tag: 'Money & reporting',
    title: 'What each property earns and costs',
    body: 'Rent, bills, loans and insurance feed one set of books, so the numbers are there when you need them — at tax time or when deciding what to do next.',
    points: [
      'P&L, NOI and cash flow by property, monthly or for the year',
      'Bank accounts synced nightly and reconciled against bills and rent',
      'Budget, expenses, loan balances and a summary of every fee paid',
    ],
    img: '/landing/money.jpg',
    alt: 'Income and cash flow by property with rental income, expenses and NOI',
  },
];

/** Smaller things it does in the background. */
const WATCH: { title: string; body: string }[] = [
  { title: 'Anomalies flagged', body: 'A bill that doubles, a charge never billed before, a month that never arrived.' },
  { title: 'Deadlines and notices', body: 'Shut-off and cancellation notices tracked until paid; due and penalty dates on one screen.' },
  { title: 'Insurance and loans', body: 'Policies, installment schedules and loan balances, kept current from their own statements.' },
];

const STEPS = [
  { n: '1', title: 'Add your properties', body: 'With their units, leases and accounts — or forward a few bills and let Sollux set them up.' },
  { n: '2', title: 'Connect portals and your bank', body: 'Logins are encrypted, and Sollux signs in only to read statements. Invite tenants to their portal when you are ready.' },
  { n: '3', title: 'Let it run', body: 'Bills are fetched on each account’s cycle, rent and bank activity sync nightly. You open Sollux to see where things stand.' },
];

const FAQ = [
  {
    q: 'Do I need to use every part of it?',
    a: 'No. Start with bills, tenants or the books — whichever you need first. Every plan includes all of it, so the rest is there when you want it.',
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
    a: 'Run the small Sollux connector on your own computer and fetches go through your own Chrome and internet. If a portal texts a code, Sollux asks you for it.',
  },
  {
    q: 'What does the trial include?',
    a: '14 days of everything, with up to 25 properties. Every plan includes all features — bills, tenants and rent collection, reporting — and plans differ only in how many properties they cover.',
  },
];

/** A stand-in of the app: one property's rent and bills, invented figures. */
function ProductPreview() {
  const rows = [
    { name: 'Rent · Unit A', amount: '$1,850.00', status: 'Paid by autopay', tone: '#34d399' },
    { name: 'Rent · Unit B', amount: '$1,750.00', status: '$875 behind', tone: '#f87171' },
    { name: 'Electric', amount: '$184.22', status: 'Due Nov 4', tone: '#60a5fa' },
    { name: 'Insurance', amount: '$234.90', status: 'Next installment Nov 3', tone: '#60a5fa' },
  ];
  return (
    <div className="rounded-2xl p-5 shadow-2xl" style={{ background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-semibold text-white">Maple Street Duplex</p>
          <p className="text-xs text-gray-500">2 units · 4 accounts · NOI $2,940/mo</p>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(248,113,113,0.12)', color: '#f87171' }}>1 tenant behind</span>
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
        Trash: a $109.23 incidental charge on this bill — first time in 12 months.
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen" style={{ background: '#141414', color: '#d1d5db' }}>
      {/* Header */}
      <header className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex items-center justify-between">
        <Logo size={30} />
        <nav className="flex items-center gap-4 text-sm">
          <a href="#pricing" className="hidden sm:inline text-gray-400 hover:text-white">Pricing</a>
          <a href="#faq" className="hidden sm:inline text-gray-400 hover:text-white">FAQ</a>
          <Link to="/sign-in" className="text-gray-300 hover:text-white">Sign in</Link>
          <Link to="/sign-up" className="rounded-lg px-3.5 py-1.5 font-medium text-black" style={{ background: GOLD }}>Start free trial</Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-10 pb-20 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: GOLD }}>For rental property owners</p>
          <h1 className="text-4xl sm:text-5xl font-semibold text-white leading-tight tracking-tight">
            Run your whole rental portfolio from one place.
          </h1>
          <p className="mt-5 text-base text-gray-400 max-w-xl">
            Bills fetched from every provider, rent collected from every tenant, and the books kept for
            every property — whether you own three units or fifty.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/sign-up" className="rounded-lg px-5 py-2.5 font-medium text-black" style={{ background: GOLD }}>Start your 14-day free trial</Link>
            <a href="#how" className="rounded-lg px-5 py-2.5 font-medium text-gray-200" style={{ border: '1px solid rgba(255,255,255,0.15)' }}>See how it works</a>
          </div>
          <p className="mt-3 text-xs text-gray-500">No card needed to start.</p>
        </div>
        <ProductPreview />
      </section>

      {/* What it runs: bills, tenants, money */}
      {PILLARS.map((p, idx) => (
        <section key={p.tag} className="max-w-6xl mx-auto px-4 sm:px-6 py-16" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="grid lg:grid-cols-5 gap-10 items-center">
            <div className={`lg:col-span-2 ${idx % 2 ? 'lg:order-2' : ''}`}>
              <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: GOLD }}>{p.tag}</p>
              <h2 className="text-2xl sm:text-3xl font-semibold text-white">{p.title}</h2>
              <p className="mt-3 text-gray-400">{p.body}</p>
              <ul className="mt-5 space-y-2.5">
                {p.points.map(pt => (
                  <li key={pt} className="flex gap-2.5 text-sm text-gray-300">
                    <span className="mt-2 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: GOLD }} />
                    {pt}
                  </li>
                ))}
              </ul>
            </div>
            <div className={`lg:col-span-3 ${idx % 2 ? 'lg:order-1' : ''}`}>
              <img src={p.img} alt={p.alt} loading="lazy" className="w-full rounded-2xl shadow-2xl"
                style={{ border: '1px solid rgba(255,255,255,0.08)' }} />
            </div>
          </div>
        </section>
      ))}

      {/* Background work */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-16" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <h2 className="text-2xl sm:text-3xl font-semibold text-white">Watching while you’re not</h2>
        <div className="mt-8 grid md:grid-cols-3 gap-4">
          {WATCH.map(f => (
            <div key={f.title} className="rounded-2xl p-5" style={{ background: '#1b1b1b', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="w-8 h-1 rounded-full mb-4" style={{ background: GOLD }} />
              <h3 className="text-base font-semibold text-white">{f.title}</h3>
              <p className="mt-2 text-sm text-gray-400 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="max-w-6xl mx-auto px-4 sm:px-6 py-16" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <h2 className="text-2xl sm:text-3xl font-semibold text-white">How it works</h2>
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

      {/* Pricing */}
      <section id="pricing" className="max-w-6xl mx-auto px-4 sm:px-6 py-16" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <h2 className="text-2xl sm:text-3xl font-semibold text-white">Simple pricing</h2>
        <p className="mt-3 text-gray-400">Every plan has everything — bills, tenants, rent collection and reporting. Pick by how many properties you own.</p>
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
        <p className="mt-4 text-xs text-gray-500">14-day free trial on every plan. Rent collection has no Sollux fee: bank transfers are free, card fees are paid by the tenant.</p>
      </section>

      {/* FAQ */}
      <section id="faq" className="max-w-3xl mx-auto px-4 sm:px-6 py-16" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
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
          <h2 className="text-2xl sm:text-3xl font-semibold text-white">Less chasing, more owning</h2>
          <p className="mt-3 text-gray-400">Bills, tenants and books in one place. Set up your first property in minutes.</p>
          <Link to="/sign-up" className="mt-6 inline-block rounded-lg px-6 py-2.5 font-medium text-black" style={{ background: GOLD }}>Start your free trial</Link>
        </div>
      </section>

      <footer className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
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
