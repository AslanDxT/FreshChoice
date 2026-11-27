import { NotificationList } from '../../components/NotificationList';

export default function Notifications() {
  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <h1>Notifications</h1>
      </div>
      <NotificationList />
    </div>
  );
}
