import React from 'react'
import Link from 'next/link'

import {
    Divider,
    Typography,
    Card,
    CardContent,
    CardActions,
    Button,
} from '@mui/material'

import {GitHub, LinkedIn, YouTube, Facebook, Instagram} from '@mui/icons-material'



export default function Landing() {

    const cardStyle = {
        border: '1px solid #30c2ff'
    }


    return (
        <div className='flex flex-row flex-wrap justify-evenly'>
            <Card className='w-full' variant='elevation' square={false} sx={cardStyle}>
                <CardContent>
                    <Typography variant="h5">Work Experience</Typography>

                    <Divider sx={{ marginTop: 1, marginBottom: 2 }} />


                </CardContent>
            </Card>

            <Card className='w-[250px]' variant='elevation' square={false} sx={cardStyle}>
                <CardContent>
                    <Typography variant="h5">Social Media</Typography>

                    <Divider sx={{ marginTop: 1, marginBottom: 2 }} />

                    <div className='flex flex-col gap-y-2'>
                        <Link href='https://github.com/ItsKodas' target='_blank'><Button fullWidth variant='outlined' startIcon={<GitHub />}>GitHub</Button></Link>
                        <Link href='https://www.linkedin.com/in/ryan-lancelot' target='_blank'><Button fullWidth variant='outlined' startIcon={<LinkedIn />}>LinkedIn</Button></Link>
                        <Link href='https://www.youtube.com/channel/UC_3OvoziBu-ztAK9PlAz9Mw' target='_blank'><Button fullWidth variant='outlined' startIcon={<YouTube />}>YouTube</Button></Link>
                        <Link href='https://www.facebook.com/ryan.j.lancelot' target='_blank'><Button fullWidth variant='outlined' startIcon={<Facebook />}>Facebook</Button></Link>
                        <Link href='https://www.instagram.com/itskodas' target='_blank'><Button fullWidth variant='outlined' startIcon={<Instagram />}>Instagram</Button></Link>
                    </div>
                </CardContent>
            </Card>

            <Card className='w-[250px]' variant='elevation' square={false} sx={cardStyle}>
                <CardContent>
                    <Typography variant="h5">Top Projects</Typography>

                    <Divider sx={{ marginTop: 1, marginBottom: 2 }} />

                    <div className='flex flex-col gap-y-2'>
                        {/* <Button onClick={() => openLink('https://github.com/ItsKodas')} fullWidth variant='outlined' startIcon={<GitHub />}>GitHub</Button>
                        <Button onClick={() => openLink('https://www.linkedin.com/in/ryan-lancelot')} fullWidth variant='outlined' startIcon={<LinkedIn />}>LinkedIn</Button> */}
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}