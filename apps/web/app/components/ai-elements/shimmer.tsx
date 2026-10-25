/**
 * AI Elements' Shimmer (registry.ai-sdk.dev), in this repo's style: text with a light sweeping across
 * it while work is in progress. Upstream animates it with `motion`; here it's the `ol-shimmer`
 * keyframes in app.css, which stop where motion is reduced.
 */

import { cn } from '@orderloop/ui/lib/utils';
import type { CSSProperties, ElementType } from 'react';

export type ShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  /** Seconds for one sweep. */
  duration?: number;
};

export const Shimmer = ({
  children,
  as: Component = 'p',
  className,
  duration = 2,
}: ShimmerProps) => (
  <Component
    className={cn('ol-shimmer', className)}
    style={
      {
        '--shimmer-spread': `${children.length * 2}px`,
        '--shimmer-duration': `${duration}s`,
      } as CSSProperties
    }
  >
    {children}
  </Component>
);
