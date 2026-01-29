import SiteFooter from "../components/SiteFooter";

export default function Privacy() {
  return (
    <div className="page policy-page">
      <section className="card policy-card">
        <p className="eyebrow">DynoWager / CraftWorld-bets</p>
        <h1>Privacy Policy</h1>
        <p className="subtle">
          <strong>Last Updated:</strong> January 29, 2026
          <br />
          <strong>Website/App:</strong> https://craftworld-bets.onrender.com
          <br />
          <strong>Contact:</strong> support@yourdomain.com
        </p>

        <section className="policy-section">
          <h2>1. Overview</h2>
          <p>
            This Privacy Policy explains what information we collect, how we use it, and your choices when you use
            DynoWager / CraftWorld-bets (the “Service”).
          </p>
        </section>

        <section className="policy-section">
          <h2>2. Information We Collect</h2>
          <h3>A) Information you provide</h3>
          <ul>
            <li>Support messages and communications (e.g., when you contact us)</li>
          </ul>
          <h3>B) Information collected automatically</h3>
          <ul>
            <li>Device and usage data (e.g., pages viewed, basic analytics events, IP address, user agent)</li>
            <li>Logs related to performance and security (e.g., error logs, request timestamps)</li>
          </ul>
          <h3>C) Blockchain information</h3>
          <ul>
            <li>Wallet addresses you connect</li>
            <li>Public blockchain transaction data (transaction hashes, token transfers, contract interactions)</li>
          </ul>
          <p>
            <strong>Note:</strong> Blockchain data is public by design and we cannot delete or modify it.
          </p>
        </section>

        <section className="policy-section">
          <h2>3. How We Use Information</h2>
          <p>We use information to:</p>
          <ul>
            <li>Provide and operate the Service (including displaying balances/markets, computing payouts)</li>
            <li>Improve and secure the Service (fraud prevention, abuse detection, debugging)</li>
            <li>Provide support and communicate with you</li>
            <li>Comply with legal obligations</li>
          </ul>
        </section>

        <section className="policy-section">
          <h2>4. How We Share Information</h2>
          <p>We may share information with:</p>
          <ul>
            <li>Infrastructure providers (hosting, analytics, error monitoring) to operate the Service</li>
            <li>Wallets, DEXs, RPC providers, and blockchain services you choose to use through the Service</li>
            <li>Legal authorities if required by law</li>
          </ul>
          <p>We do not sell your personal information.</p>
        </section>

        <section className="policy-section">
          <h2>5. Cookies / Similar Technologies</h2>
          <p>We may use cookies or local storage for:</p>
          <ul>
            <li>Session preferences</li>
            <li>Basic analytics</li>
            <li>Security protections (rate-limiting / abuse prevention)</li>
          </ul>
          <p>You can control cookies via your browser settings. Some features may not work without them.</p>
        </section>

        <section className="policy-section">
          <h2>6. Data Retention</h2>
          <p>We retain:</p>
          <ul>
            <li>Support communications and operational logs for as long as needed for support, security, and compliance.</li>
            <li>Public blockchain data is retained by the blockchain network and third-party indexers.</li>
          </ul>
        </section>

        <section className="policy-section">
          <h2>7. Security</h2>
          <p>
            We use reasonable administrative, technical, and organizational safeguards to protect information. However,
            no method of transmission or storage is 100% secure.
          </p>
        </section>

        <section className="policy-section">
          <h2>8. Your Choices and Rights</h2>
          <p>Depending on your location, you may have rights to:</p>
          <ul>
            <li>Request access to the personal information we hold about you</li>
            <li>Request deletion or correction of certain information (excluding public blockchain data)</li>
            <li>Opt out of certain analytics where available</li>
          </ul>
          <p>
            To exercise requests, contact: <strong>support@yourdomain.com</strong>.
          </p>
        </section>

        <section className="policy-section">
          <h2>9. Children</h2>
          <p>The Service is not intended for children. We do not knowingly collect information from anyone under 18.</p>
        </section>

        <section className="policy-section">
          <h2>10. International Users</h2>
          <p>
            If you access the Service from outside the United States, you understand your information may be processed
            in the United States or other locations where our providers operate.
          </p>
        </section>

        <section className="policy-section">
          <h2>11. Changes to this Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. The “Last Updated” date will reflect changes.
          </p>
        </section>

        <section className="policy-section">
          <h2>12. Contact</h2>
          <p>Questions: <strong>support@yourdomain.com</strong></p>
        </section>
      </section>
      <SiteFooter />
    </div>
  );
}
