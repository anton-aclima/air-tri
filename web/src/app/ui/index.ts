/**
 * air — the primitive library. Import from `@/app/ui`:
 *
 *   import { Button, Card, Panel, Stat, Table } from '@/app/ui'
 *
 * Every primitive is skin-agnostic: it reads semantic tokens only, so it looks
 * native in community, regulator, industry and admin with no changes.
 */

export { Icon, ICON_NAMES, type IconProps } from '@/app/ui/Icon'

export {
  Button, IconButton, Toggle, Slider, Field, Input, Textarea, Select, Segmented,
  type ButtonProps, type ButtonVariant, type ControlSize, type IconButtonProps,
  type ToggleProps, type SliderProps, type FieldProps, type InputProps,
  type TextareaProps, type SelectProps, type SelectOption, type SegmentedProps,
} from '@/app/ui/controls'

export {
  Card, Panel, Toolbar, Spacer, Divider, Kbd, Tabs, Tooltip, Modal, Sheet,
  type CardProps, type PanelProps, type TabsProps, type TabItem,
  type TooltipProps, type ModalProps, type SheetProps,
} from '@/app/ui/surfaces'

export {
  Badge, SeverityBadge, Chip, SeverityDot, Stat, StatRow, Table, Skeleton,
  SkeletonText, Empty, Spinner, Avatar, AvatarStack,
  type BadgeProps, type BadgeTone, type ChipProps, type SeverityDotProps,
  type StatProps, type TableProps, type Column, type SkeletonProps,
  type EmptyProps, type AvatarProps,
} from '@/app/ui/data'
