import type { ReactNode } from "react";
import "./VerifyGate.css";

type VerifyGateProps = {
  children: ReactNode;
  className?: string;
};

export default function VerifyGate({ children, className }: VerifyGateProps) {
  const classes = ["verify-gate-play-area", className].filter(Boolean).join(" ");
  return <div className={classes}>{children}</div>;
}
