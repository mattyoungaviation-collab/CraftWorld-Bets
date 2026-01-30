import SiteFooter from "../components/SiteFooter";

export default function Terms() {
  return (
    <div className="page policy-page">
      <section className="card policy-card">
        <p className="eyebrow">DynoWager / CraftWorld-bets</p>
        <h1>User Terms Policy</h1>
        <p className="subtle">
          <strong>Last Updated:</strong> January 29, 2026
          <br />
          <strong>Project:</strong> DynoWager / CraftWorld-bets (the “Service”)
          <br />
          <strong>Website:</strong> https://craftworld-bets.onrender.com
          <br />
          <strong>Contact:</strong> support@yourdomain.com
          <br />
          <strong>Operator:</strong> Matt / DynoWager (“we”, “us”, “our”)
        </p>

        <section className="policy-section">
          <h2>1. Acceptance of Terms</h2>
          <p>
            By accessing or using the Service, you agree to these User Terms (“Terms”). If you do not agree, do not use
            the Service.
          </p>
        </section>

        <section className="policy-section">
          <h2>2. Eligibility; Legal Compliance</h2>
          <p>You represent and warrant that:</p>
          <ul>
            <li>
              You are at least <strong>18 years old</strong> (or the age of majority where you live).
            </li>
            <li>
              You are legally permitted to use blockchain services and participate in wagering/prediction activities in
              your jurisdiction.
            </li>
            <li>
              You are not located in, resident of, or accessing the Service from a jurisdiction where use of the Service
              is illegal.
            </li>
          </ul>
          <p>You are solely responsible for understanding and complying with all applicable laws, rules, and regulations.</p>
        </section>

        <section className="policy-section">
          <h2>3. What the Service Does</h2>
          <p>The Service is a Ronin-based application that may allow users to:</p>
          <ul>
            <li>Connect a wallet (e.g., Ronin Wallet) to interact with the Service,</li>
            <li>Deposit DYNW into a non-custodial Vault Ledger smart contract,</li>
            <li>
              Place bets/predictions on Craft World–themed outcomes (e.g., leaderboard placements, Masterpiece results),
            </li>
            <li>Receive payouts according to market rules and settlement logic.</li>
          </ul>
        </section>

        <section className="policy-section">
          <h2>4. No Financial, Investment, or Tax Advice</h2>
          <p>
            Nothing on the Service constitutes financial, investment, legal, or tax advice. You are solely responsible
            for your decisions and actions, including depositing tokens and placing bets.
          </p>
        </section>

        <section className="policy-section">
          <h2>5. Risk Disclosures</h2>
          <p>You understand and accept the risks of using blockchain systems, including but not limited to:</p>
          <ul>
            <li>
              <strong>Irreversible transactions:</strong> blockchain transactions cannot be reversed.
            </li>
            <li>
              <strong>Wallet security:</strong> you are responsible for your wallet, seed phrase, private keys, and
              approvals/signatures.
            </li>
            <li>
              <strong>Smart contract risk:</strong> smart contracts may contain vulnerabilities, errors, or may be
              exploited.
            </li>
            <li>
              <strong>Network risk:</strong> congestion, RPC issues, chain reorganizations, outages, or other failures can
              cause delays or losses.
            </li>
            <li>
              <strong>Token price volatility:</strong> token values may fluctuate and may become illiquid.
            </li>
          </ul>
          <p>To the maximum extent permitted by law, we are not responsible for losses arising from these risks.</p>
        </section>

        <section className="policy-section">
          <h2>6. Accounts, Wallet Connection, and Permissions</h2>
          <p>
            To use the Service, you may be required to connect a wallet and approve certain permissions. You are
            responsible for reviewing every transaction you sign.
          </p>
          <p>
            If the Service supports a streamlined experience (e.g., fewer prompts), you understand that you may be
            granting permissions that enable future actions consistent with the Service’s features and rules. You can
            revoke token approvals from your wallet tools at any time, subject to network conditions.
          </p>
        </section>

        <section className="policy-section">
          <h2>7. Markets, Betting Rules, and Payouts</h2>
          <p>Each market will display, at minimum:</p>
          <ul>
            <li>The market question and eligible outcomes,</li>
            <li>The betting open/close time,</li>
            <li>The payout method (including proportional payouts if applicable),</li>
            <li>Any fees and how they are applied,</li>
            <li>The settlement source/rules.</li>
          </ul>
          <p>
            <strong>All wagers are final</strong> once submitted on-chain (or once confirmed by the Service if a non-on-chain
            step exists). Payouts are calculated based on the market rules shown at the time the bet was placed.
          </p>
        </section>

        <section className="policy-section">
          <h2>8. Settlement Source; Disputes; Market Integrity</h2>
          <p>
            Markets settle using the settlement method disclosed in the market rules (for example: Craft World
            leaderboard data at a defined time from an official or publicly accessible source).
          </p>
          <p>
            If there is ambiguity, downtime, data inconsistency, suspected manipulation, or other integrity concerns, we
            may:
          </p>
          <ul>
            <li>Delay settlement,</li>
            <li>Use a reasonable fallback data source consistent with the disclosed rules,</li>
            <li>Cancel and refund a market (where feasible),</li>
            <li>Take other actions necessary to protect market integrity.</li>
          </ul>
          <p>Settlement decisions made in accordance with the disclosed rules are final.</p>
        </section>

        <section className="policy-section">
          <h2>9. Fees</h2>
          <p>
            The Service may charge fees (e.g., market fees, settlement fees). Any applicable fees will be disclosed in
            the user interface and/or documentation. Fees may change over time but will not apply retroactively to
            already-placed wagers.
          </p>
        </section>

        <section className="policy-section">
          <h2>10. Custody; In-App Balances (IMPORTANT)</h2>
          <p>The Service uses a non-custodial design:</p>
          <p>
            Users retain control of their wallet. Funds are deposited into a Vault Ledger smart contract that enforces
            the betting rules, maintains an internal ledger, and allows withdrawals at any time.
          </p>
        </section>

        <section className="policy-section">
          <h2>11. Prohibited Conduct</h2>
          <p>You agree not to:</p>
          <ul>
            <li>Break any laws or regulations,</li>
            <li>Engage in fraud, collusion, market manipulation, or fixing outcomes,</li>
            <li>Attempt to exploit bugs, vulnerabilities, or bypass security measures,</li>
            <li>Use the Service to launder funds or violate sanctions,</li>
            <li>Use bots or automated activity that disrupts the Service or unfairly manipulates markets.</li>
          </ul>
          <p>We may restrict access and/or cancel participation where feasible if we suspect prohibited conduct.</p>
        </section>

        <section className="policy-section">
          <h2>12. Taxes</h2>
          <p>
            You are responsible for determining and paying any taxes arising from your use of the Service, including
            deposits and winnings.
          </p>
        </section>

        <section className="policy-section">
          <h2>13. Third-Party Services</h2>
          <p>
            The Service may integrate third-party tools (wallets, DEXs, bridges, APIs, data sources). We do not control
            third parties and are not responsible for their performance, availability, or security.
          </p>
        </section>

        <section className="policy-section">
          <h2>14. Suspension; Termination</h2>
          <p>
            We may suspend or terminate access to the Service for security, legal, or operational reasons, or if we
            reasonably believe you violated these Terms.
          </p>
        </section>

        <section className="policy-section">
          <h2>15. Disclaimer of Warranties</h2>
          <p>
            THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE” WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED,
            INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
          </p>
        </section>

        <section className="policy-section">
          <h2>16. Limitation of Liability</h2>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, CONSEQUENTIAL,
            SPECIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF FUNDS, PROFITS, DATA, OR GOODWILL.
          </p>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL LIABILITY FOR ANY CLAIM RELATING TO THE SERVICE WILL NOT
            EXCEED THE GREATER OF (A) USD $100 OR (B) THE FEES YOU PAID TO US IN THE PRIOR 30 DAYS.
          </p>
        </section>

        <section className="policy-section">
          <h2>17. Indemnification</h2>
          <p>
            You agree to indemnify and hold us harmless from claims arising out of your use of the Service, your
            violation of these Terms, or your violation of any law or rights of any third party.
          </p>
        </section>

        <section className="policy-section">
          <h2>18. Changes to Terms</h2>
          <p>
            We may update these Terms from time to time. The “Last Updated” date will change. Your continued use after
            updates means you accept the revised Terms.
          </p>
        </section>

        <section className="policy-section">
          <h2>19. Contact</h2>
          <p>Questions: <strong>support@yourdomain.com</strong></p>
        </section>
      </section>
      <SiteFooter />
    </div>
  );
}
