import { Button } from '@douyinfe/semi-ui-19';
import { IconEyeClosed, IconMail, IconUndo } from '@douyinfe/semi-icons';

/**
 * "Not interested" and "Messaged" for a visible offer, "Restore" for a hidden one. Clicks never reach a
 * surrounding clickable element (tile), so pressing a button does not select the offer.
 */
export default function DismissButton({ item, onDismiss, onMessaged, onRestore, size = 'small' }) {
  const act = (fn) => (e) => {
    e.stopPropagation();
    fn(item);
  };
  if (item.dismissed) {
    return (
      <Button size={size} theme="borderless" type="tertiary" icon={<IconUndo />} onClick={act(onRestore)}>
        Restore
      </Button>
    );
  }
  return (
    <>
      <Button size={size} theme="borderless" type="tertiary" icon={<IconEyeClosed />} onClick={act(onDismiss)}>
        Not interested
      </Button>
      {onMessaged && (
        <Button size={size} theme="borderless" type="tertiary" icon={<IconMail />} onClick={act(onMessaged)}>
          Messaged
        </Button>
      )}
    </>
  );
}
