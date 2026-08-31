import { Link } from '@tanstack/react-router'

import { Button, Empty } from '@/app/ui'

export function NotFound() {
  return (
    <Empty
      icon="search"
      title="No such screen"
      action={
        <Link to="/">
          <Button variant="primary" icon="aclima">
            Back to the persona picker
          </Button>
        </Link>
      }
    >
      That route does not exist in this prototype. Press <kbd>⌘K</kbd> to switch interface.
    </Empty>
  )
}
