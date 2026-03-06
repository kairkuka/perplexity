import type { NeedApprovalEvent } from "@agent/shared";

interface ApprovalModalProps {
  approval: NeedApprovalEvent | null;
  onApprove: () => void;
  onDeny: () => void;
}

export function ApprovalModal({ approval, onApprove, onDeny }: ApprovalModalProps): JSX.Element | null {
  if (!approval) {
    return null;
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h3>Action Approval Needed</h3>
        <p>{approval.reason}</p>
        <div className="modal-actions">
          <button onClick={onApprove}>
            Approve
          </button>
          <button className="danger" onClick={onDeny}>
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
