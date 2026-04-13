import { Body, Controller, Get, Post, Query, HttpException, HttpStatus } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('init')
  async init(@Query('template_id') templateId?: string) {
    try {
      return await this.appService.getFilters(templateId || 'icons_hpov');
    } catch (error) {
      throw new HttpException({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: error.message,
      }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  @Post('search')
  async search(@Body() body: { 
    template_id: string; 
    project_name: string; 
    filters?: Record<string, any>; 
    size?: number; 
    search_after?: string[] 
  }) {
    const { template_id, project_name, filters = {}, size = 100, search_after } = body;
    try {
      return await this.appService.search(template_id, project_name, filters, size, search_after);
    } catch (error) {
      throw new HttpException({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: error.message,
      }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  @Post('setup')
  async setup(@Body() body: { template_id: string; project_name: string }) {
    try {
      return await this.appService.setupIndexAndSample(body.template_id, body.project_name);
    } catch (error) {
      throw new HttpException({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: error.message,
      }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  @Post('seed')
  async seed(@Body() body: { template_id: string; project_name: string; count?: number }) {
    try {
      return await this.appService.seedData(body.template_id, body.project_name, body.count || 50);
    } catch (error) {
      throw new HttpException({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: error.message,
      }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
