/**
 * Public privacy policy and terms of service. Google's OAuth consent screen
 * links to both, and will not publish the app without them, so they are
 * reachable without signing in.
 */
import { Link } from 'react-router-dom';

const CONTACT = 'farhantalukder6@gmail.com';
const UPDATED = 'October 4, 2026';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen px-4 py-10" style={{ background: '#141414', color: '#d1d5db' }}>
      <div className="max-w-2xl mx-auto">
        <p className="text-sm font-semibold mb-6" style={{ color: '#F5A623' }}>Sollux</p>
        <h1 className="text-2xl font-semibold text-white mb-1">{title}</h1>
        <p className="text-xs text-gray-500 mb-8">Last updated {UPDATED}</p>
        <div className="space-y-5 text-sm leading-relaxed [&_h2]:text-white [&_h2]:font-semibold [&_h2]:text-base [&_h2]:mt-8 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1">
          {children}
        </div>
        <p className="text-xs text-gray-600 mt-12">
          <Link to="/privacy" className="hover:text-gray-400">Privacy policy</Link>
          {' · '}
          <Link to="/terms" className="hover:text-gray-400">Terms of service</Link>
        </p>
      </div>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <Shell title="Privacy policy">
      <p>
        Sollux is a private tool for managing the bills, loans, insurance and tenants of a real estate portfolio.
        This policy explains what it collects, why, and what it never does.
      </p>

      <h2>What Sollux collects</h2>
      <ul>
        <li>Your sign-in details (name and email), handled by our sign-in provider, Clerk.</li>
        <li>What you enter or import: properties, utility and loan accounts, statements, payments, tenants and leases.</li>
        <li>Utility portal logins you choose to save. They are encrypted (AES-256-GCM) before they are stored and are never shown back in full.</li>
        <li>Bank account and transaction data, if you connect a bank through Plaid. Account numbers are kept to the last four digits.</li>
      </ul>

      <h2>Google account data</h2>
      <p>If you connect Gmail or Google Drive, Sollux asks for read-only access and uses it only to find and file your bills:</p>
      <ul>
        <li><strong>Gmail (read-only):</strong> Sollux reads messages that look like bills, statements or payment confirmations, and their PDF attachments, to record the amount, due date and account. It does not send, delete or change email.</li>
        <li><strong>Google Drive (read-only):</strong> Sollux reads the folders and files you choose to import.</li>
      </ul>
      <p>
        Sollux's use and transfer of information received from Google APIs adheres to the{' '}
        <a className="underline" href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>,
        including the Limited Use requirements. Google data is used only to provide these features to you. It is not sold, not used for advertising,
        not used to train general AI models, and not read by people except when you ask for help, for security, or as the law requires.
      </p>

      <h2>How data is processed</h2>
      <p>
        To read a bill, Sollux sends that document to Anthropic's Claude API, which extracts its figures. The document is processed only to return that result.
        Data is stored with our hosting and database providers (Render, Vercel and Neon) and in private file storage (Amazon S3), where documents
        are opened only through short-lived signed links.
      </p>

      <h2>The vault</h2>
      <p>
        Records in the vault are encrypted in your browser with a key that only your vault passphrase or recovery key unlocks. Sollux's servers never
        receive that passphrase, that key or the unencrypted contents, so nobody at Sollux can read them.
      </p>

      <h2>Sharing</h2>
      <p>Sollux does not sell or rent your data. It shares data only with the service providers above, to run the features you use.</p>

      <h2>Your choices</h2>
      <ul>
        <li>Disconnect Gmail, Drive or a bank at any time in Settings, or remove Sollux's access from your Google Account at myaccount.google.com/permissions.</li>
        <li>To delete your account and data, email {CONTACT}. It is deleted within 30 days.</li>
      </ul>

      <h2>Contact</h2>
      <p>Questions about this policy: {CONTACT}.</p>
    </Shell>
  );
}

export function TermsPage() {
  return (
    <Shell title="Terms of service">
      <p>By using Sollux you agree to these terms.</p>

      <h2>The service</h2>
      <p>
        Sollux helps you track the bills, payments, loans, insurance and tenants of properties you own or manage. It reads documents you import or
        connect, and it can make mistakes. Check figures against the original statement before relying on them, and before paying.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>Keep your sign-in, and your vault passphrase and recovery key, safe. A lost vault passphrase and recovery key cannot be recovered.</li>
        <li>Connect only accounts and mailboxes you are authorised to use.</li>
        <li>You remain responsible for your bills, payments, taxes and obligations to tenants.</li>
      </ul>

      <h2>Not advice</h2>
      <p>Sollux's insights, reminders and tax summaries are informational, not legal, tax or financial advice.</p>

      <h2>Availability and liability</h2>
      <p>
        Sollux is provided as is, without warranties. To the extent the law allows, Sollux is not liable for indirect or consequential losses, including
        late fees, penalties or missed payments.
      </p>

      <h2>Ending use</h2>
      <p>You can stop using Sollux and ask for your data to be deleted at any time by emailing {CONTACT}.</p>

      <h2>Contact</h2>
      <p>{CONTACT}</p>
    </Shell>
  );
}
