import { Box } from '@chakra-ui/react';

import AllDrops from '../components/AllDrops';

export default function AllEventsPage() {
  return (
    <Box mb={{ base: '5', md: '14' }} minH="100%" minW="100%" mt={{ base: '52px', md: '100px' }}>
      <AllDrops ctaButtonLabel="Create Event" hasDateFilter={true} pageTitle="My Events" />
    </Box>
  );
}
