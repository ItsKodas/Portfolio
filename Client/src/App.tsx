import React from 'react'

import ParallaxView from './components/parallax'

import {
	ThemeProvider,
	createTheme,

	Divider,

	Typography,
	Card,
	CardContent,
	CardActions,

	Button,
} from '@mui/material'

import * as Colors from '@mui/material/colors'
import * as Icons from '@mui/icons-material'



const darkTheme = createTheme({
	typography: {
		fontFamily: 'Montserrat, sans-serif',
		button: {
			textTransform: 'none'
		}
	},

	palette: {
		mode: 'dark',

		primary: Colors.lightBlue,

		background: {
			default: '#101727',
			paper: '#0b0d1c'
		}
	}
})

const cardStyle = {
	border: '1px solid #30c2ff'
}


export default function App() {

	const openLink = (url: string) => window.open(url, '_blank')


	return (
		<ThemeProvider theme={darkTheme}>
			<div className='h-screen w-screen bg-[#101727]'>
				<ParallaxView>

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
									<Button onClick={() => openLink('https://github.com/ItsKodas')} fullWidth variant='outlined' startIcon={<Icons.GitHub />}>GitHub</Button>
									<Button onClick={() => openLink('https://www.linkedin.com/in/ryan-lancelot')} fullWidth variant='outlined' startIcon={<Icons.LinkedIn />}>LinkedIn</Button>
									<Button onClick={() => openLink('https://www.youtube.com/channel/UC_3OvoziBu-ztAK9PlAz9Mw')} fullWidth variant='outlined' startIcon={<Icons.YouTube />}>YouTube</Button>
									<Button onClick={() => openLink('https://www.facebook.com/ryan.j.lancelot')} fullWidth variant='outlined' startIcon={<Icons.Facebook />}>Facebook</Button>
									<Button onClick={() => openLink('https://www.instagram.com/itskodas')} fullWidth variant='outlined' startIcon={<Icons.Instagram />}>Instagram</Button>
								</div>
							</CardContent>
						</Card>

						<Card className='w-[250px]' variant='elevation' square={false} sx={cardStyle}>
							<CardContent>
								<Typography variant="h5">Top Projects</Typography>

								<Divider sx={{ marginTop: 1, marginBottom: 2 }} />

								<div className='flex flex-col gap-y-2'>
									<Button onClick={() => openLink('https://github.com/ItsKodas')} fullWidth variant='outlined' startIcon={<Icons.GitHub />}>GitHub</Button>
									<Button onClick={() => openLink('https://www.linkedin.com/in/ryan-lancelot')} fullWidth variant='outlined' startIcon={<Icons.LinkedIn />}>LinkedIn</Button>
								</div>
							</CardContent>
						</Card>
					</div>

				</ParallaxView>
			</div>
		</ThemeProvider>
	)
}



{/* <Typography sx={{ fontSize: 14 }} color="text.secondary" gutterBottom>Word of the Day</Typography>
<Typography variant="h5" component="div">be nev o lent</Typography>
<Typography sx={{ mb: 1.5 }} color="text.secondary">adjective</Typography>
<Typography variant="body2">well meaning and kindly.<br />{'"a benevolent smile"'}</Typography> 
<CardActions>
	<Button size="small">Learn More</Button>
</CardActions>*/}