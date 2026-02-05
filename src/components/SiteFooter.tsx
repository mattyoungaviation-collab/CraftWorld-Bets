import { Link } from "react-router-dom";

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-links">
        <Link to="/terms">Terms</Link>
        <span aria-hidden="true">•</span>
        <Link to="/privacy">Privacy</Link>
      </div>
      <div className="site-footer-meta">© 2026 CraftWorld Bets</div>
    </footer>
  );
}
