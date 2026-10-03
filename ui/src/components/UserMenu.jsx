import { Button, Tag } from '@douyinfe/semi-ui-19';
import { IconExit, IconSetting } from '@douyinfe/semi-icons';

/** Header: who is logged in (admin badge for the owner), the gear that opens the Options view, "About" (the presentation page) and Logout. */
export default function UserMenu({ user, onLogout, onOptions, onAbout, optionsOpen = false }) {
  return (
    <div className="user-menu">
      <span className="user-menu__name" title={user.email ?? undefined}>
        {user.username}
      </span>
      {user.admin && (
        <Tag color="orange" size="small">
          admin
        </Tag>
      )}
      <Button
        size="small"
        theme={optionsOpen ? 'light' : 'borderless'}
        icon={<IconSetting />}
        onClick={onOptions}
        aria-label="Options"
        aria-pressed={optionsOpen}
        title="Options"
      />
      {onAbout && (
        <Button size="small" theme="borderless" onClick={onAbout}>
          About
        </Button>
      )}
      <Button size="small" theme="borderless" icon={<IconExit />} onClick={onLogout}>
        Logout
      </Button>
    </div>
  );
}
