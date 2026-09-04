import { Card, CardContent, CardHeader, Skeleton } from 'yantra-web';

export const Lines = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '20rem' }}>
    <Skeleton style={{ height: '1rem', width: '60%' }} />
    <Skeleton style={{ height: '1rem', width: '90%' }} />
    <Skeleton style={{ height: '1rem', width: '75%' }} />
  </div>
);

export const WorkspaceRow = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', maxWidth: '24rem' }}>
    <Skeleton style={{ height: '2.25rem', width: '2.25rem', borderRadius: '9999px' }} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
      <Skeleton style={{ height: '0.875rem', width: '35%' }} />
      <Skeleton style={{ height: '0.75rem', width: '55%' }} />
    </div>
    <Skeleton style={{ height: '1.25rem', width: '4rem', borderRadius: '9999px' }} />
  </div>
);

export const LoadingCard = () => (
  <Card style={{ maxWidth: '24rem' }}>
    <CardHeader>
      <Skeleton style={{ height: '1rem', width: '8rem' }} />
      <Skeleton style={{ height: '0.75rem', width: '12rem' }} />
    </CardHeader>
    <CardContent style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <Skeleton style={{ height: '0.75rem', width: '100%' }} />
      <Skeleton style={{ height: '0.75rem', width: '80%' }} />
      <Skeleton style={{ height: '0.75rem', width: '90%' }} />
    </CardContent>
  </Card>
);
