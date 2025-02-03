import { createTheme } from "@mui/material"
import * as Colors from '@mui/material/colors'


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


export default darkTheme