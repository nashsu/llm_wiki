interface SidebarProjectTitleProps {
  name: string
}

export function SidebarProjectTitle({ name }: SidebarProjectTitleProps) {
  return (
    <div className="mb-3 max-w-full whitespace-normal break-words px-2 pb-1 pt-3 text-xs font-semibold uppercase leading-5 text-muted-foreground">
      {name}
    </div>
  )
}
