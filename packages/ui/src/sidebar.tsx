import { cva, type VariantProps } from 'class-variance-authority';
import { PanelLeftIcon } from 'lucide-react';
import { Slot } from 'radix-ui';
import * as React from 'react';

import { cn } from './lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

/*
 * shadcn's Sidebar (radix-maia), adapted for OrderLoop:
 * - Phones have the shell's tab bar, so there is no mobile Sheet: the sidebar is md and up only.
 * - `overlay` replaces `isMobile`: the sidebar stays an icon rail beside the page and its toggle
 *   opens it over the page (`peek`) instead of pushing it, leaving `open` (the reader's choice)
 *   alone. The shell sets it below lg, on canvas pages and beside the assistant's column.
 * - Below lg it is a rail by CSS as well, and the icon-only look (`@max-[8rem]`, a container query
 *   on the panel) follows its drawn width rather than `data-state`, so it is right before hydration.
 * - The shortcut is ⌘\ (Ctrl+\): Ctrl+B opens Firefox's bookmarks.
 * - Icons sit at the same x expanded and collapsed, and a group's label keeps its height as a
 *   hairline, so nothing moves as it narrows.
 */

const SIDEBAR_COOKIE_NAME = 'sidebar_state';
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const SIDEBAR_WIDTH = '16rem';
const SIDEBAR_WIDTH_ICON = '3.25rem';
const SIDEBAR_KEYBOARD_SHORTCUT = '\\';

type SidebarContextProps = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (open: boolean) => void;
  overlay: boolean;
  peek: boolean;
  setPeek: (peek: boolean) => void;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.');
  }
  return context;
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  overlay = false,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  overlay?: boolean;
}) {
  const [peek, setPeek] = React.useState(false);

  // The reader's choice, controlled from outside with open and onOpenChange if given.
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value;
      if (setOpenProp) setOpenProp(openState);
      else _setOpen(openState);
      // A cookie, so the server draws the sidebar at the width it was left at.
      // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API needs Safari 18.4; iPads run older.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
    },
    [setOpenProp, open],
  );

  // Leaving overlay (the window widened, the canvas page closed) puts the panel back.
  React.useEffect(() => {
    if (!overlay) setPeek(false);
  }, [overlay]);

  const toggleSidebar = React.useCallback(() => {
    return overlay ? setPeek((p) => !p) : setOpen((o) => !o);
  }, [overlay, setOpen]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidebar]);

  const state = (overlay ? peek : open) ? 'expanded' : 'collapsed';

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({ state, open, setOpen, overlay, peek, setPeek, toggleSidebar }),
    [state, open, setOpen, overlay, peek, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            '--sidebar-width': SIDEBAR_WIDTH,
            '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        className={cn('group/sidebar-wrapper flex min-h-svh w-full', className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

/** The panel's slide: the theme's travel time on the arriving ease; reduced motion jumps. */
const slide = 'duration-(--motion-travel) ease-(--ease-arrive) motion-reduce:transition-none';

function Sidebar({ className, children, ...props }: React.ComponentProps<'div'>) {
  const { state, overlay, peek, setPeek } = useSidebar();
  const container = React.useRef<HTMLDivElement>(null);

  // Opened over the page, it closes on Escape or a press anywhere else (menus it opened aside).
  React.useEffect(() => {
    if (!peek) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!container.current?.contains(t) && !t.closest('[data-radix-popper-content-wrapper]'))
        setPeek(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setPeek(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [peek, setPeek]);

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? 'icon' : ''}
      data-overlay={overlay || undefined}
      data-peek={peek || undefined}
      data-slot="sidebar"
    >
      {/* The room it takes beside the page: a rail whenever it opens over the page. */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          'relative w-(--sidebar-width) bg-transparent transition-[width] max-lg:w-(--sidebar-width-icon) group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[overlay]:w-(--sidebar-width-icon)',
          slide,
        )}
      />
      <div
        ref={container}
        data-slot="sidebar-container"
        className={cn(
          'fixed inset-y-0 left-0 z-40 hidden h-svh w-(--sidebar-width) border-r border-sidebar-border transition-[width,box-shadow] max-lg:w-(--sidebar-width-icon) group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[peek]:z-50 group-data-[peek]:w-(--sidebar-width)! group-data-[peek]:shadow-overlay md:flex',
          slide,
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="@container flex size-full flex-col overflow-hidden bg-sidebar"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({
  className,
  onClick,
  children,
  ...props
}: React.ComponentProps<'button'>) {
  const { toggleSidebar, state } = useSidebar();
  return (
    <button
      type="button"
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      aria-expanded={state === 'expanded'}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent focus-visible:ring-2',
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      {children ?? (
        <>
          <PanelLeftIcon className="size-4" />
          <span className="sr-only">Toggle Sidebar</span>
        </>
      )}
    </button>
  );
}

/** The panel's edge: a press there toggles it, as in shadcn. */
function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      className={cn(
        'absolute inset-y-0 -right-2 z-20 hidden w-4 cursor-w-resize transition-all after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex',
        '[[data-state=collapsed]_&]:cursor-e-resize',
        className,
      )}
      {...props}
    />
  );
}

/** What sits beside the sidebar. A div: the shell has its own <main> inside it. */
function SidebarInset({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn('relative flex w-full min-w-0 flex-1 flex-col bg-background', className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<'hr'>) {
  return (
    <hr
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn('mx-2 h-px shrink-0 border-0 bg-sidebar-border', className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto overflow-x-hidden [scrollbar-width:thin]',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  );
}

/** As a rail the label keeps its height and becomes a hairline, its words left to screen readers. */
function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        'relative flex h-8 shrink-0 items-center rounded-md px-2.5 font-medium text-sidebar-foreground/70 text-xs outline-hidden ring-sidebar-ring focus-visible:ring-2 after:absolute after:inset-x-1 after:top-1/2 after:hidden after:h-px after:bg-sidebar-border @max-[8rem]:select-none @max-[8rem]:text-transparent @max-[8rem]:after:block [&>svg]:size-4 [&>svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn('w-full text-sm', className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn('flex w-full min-w-0 flex-col gap-0.5', className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  );
}

/*
 * px-2.5 inside the group's p-2 puts the icon's centre 26px in, which is the centre of a 3.25rem
 * rail: expanded or collapsed, the icon doesn't move. As a rail, the last span (the name) goes to
 * screen readers.
 */
const sidebarMenuButtonVariants = cva(
  'peer/menu-button group/menu-button relative flex w-full items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-lg px-2.5 py-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[color,background-color] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-has-data-[sidebar=menu-badge]/menu-item:pr-11 data-open:bg-sidebar-accent data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground @max-[8rem]:pr-2.5! @max-[8rem]:[&>span:last-child]:sr-only [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1 [&>span:last-child]:truncate [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        outline:
          'bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]',
      },
      size: {
        default: 'h-9 text-sm',
        sm: 'h-8 text-xs',
        lg: 'h-12 text-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : 'button';
  const { state } = useSidebar();

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive || undefined}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );

  if (!tooltip) return button;
  const content = typeof tooltip === 'string' ? { children: tooltip } : tooltip;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== 'collapsed'} {...content} />
    </Tooltip>
  );
}

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  showOnHover?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        'absolute top-2 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 peer-hover/menu-button:text-sidebar-accent-foreground @max-[8rem]:hidden md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0',
        showOnHover &&
          'group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 aria-expanded:opacity-100 peer-data-active/menu-button:text-sidebar-accent-foreground md:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

/** A count at the row's end; a rail hides it (the row can carry its own mark for that). */
function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        'pointer-events-none absolute inset-y-0 right-2 flex select-none items-center font-medium text-sidebar-foreground text-xs tabular-nums @max-[8rem]:hidden',
        className,
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
};
